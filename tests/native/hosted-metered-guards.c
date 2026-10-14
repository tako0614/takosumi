#define _GNU_SOURCE
/*
 * White-box syscall-fault tests ONLY. Regular files intentionally stand in for
 * kernel text here; this executable never qualifies a counter or emits usage.
 * The separate restrictive-container gate proves the genuine kernel boundary.
 */
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/types.h>
#include <unistd.h>

static pid_t unit_getpid(void);
static uid_t unit_getuid(void);
static int unit_prctl(int option, ...);
static int unit_open(const char *path, int flags, ...);
static int unit_fstatat(int dirfd, const char *path, struct stat *status, int flags);
static int unit_fstatfs(int descriptor, struct statfs *filesystem);
static int unit_kill(pid_t pid, int signal_number);
#define getpid unit_getpid
#define getuid unit_getuid
#define geteuid unit_getuid
#define prctl unit_prctl
#define open unit_open
#define fstatat unit_fstatat
#define fstatfs unit_fstatfs
#define kill unit_kill
#include "../../runner/native/hosted-metered-supervisor.c"
#undef getpid
#undef getuid
#undef geteuid
#undef prctl
#undef open
#undef fstatat
#undef fstatfs
#undef kill

static char unit_directory[128];
static char membership_path[160];
static char counter_path[160];
static int tests;
static int cleanup_kill_calls;

static void unit_fail(const char *label) {
  fprintf(stderr, "native fault guard failed: %s\n", label);
  exit(1);
}

static pid_t unit_getpid(void) { return 1; }
static uid_t unit_getuid(void) { return 0; }
static int unit_prctl(int option, ...) {
  if (option == PR_GET_DUMPABLE)
    return 0;
  if (option == PR_GET_CHILD_SUBREAPER) {
    va_list arguments;
    va_start(arguments, option);
    int *subreaper = va_arg(arguments, int *);
    va_end(arguments);
    *subreaper = 1;
    return 0;
  }
  errno = EPERM;
  return -1;
}
static int unit_open(const char *path, int flags, ...) {
  if (strcmp(path, "/proc/self/cgroup") == 0)
    return open(membership_path, flags);
  errno = EPERM;
  return -1;
}
static int unit_fstatat(int dirfd, const char *path, struct stat *status,
                        int flags) {
  if (strcmp(path, "/sys/fs/cgroup") == 0)
    return fstatat(AT_FDCWD, unit_directory, status, flags);
  return fstatat(dirfd, path, status, flags);
}
static int unit_fstatfs(int descriptor, struct statfs *filesystem) {
  memset(filesystem, 0, sizeof(*filesystem));
  filesystem->f_type = descriptor == counter_fd ? CGROUP2_SUPER_MAGIC : PROC_SUPER_MAGIC;
  return 0;
}
static int unit_kill(pid_t pid, int signal_number) {
  if (pid != -1 || signal_number != SIGKILL)
    unit_fail("cleanup signal scope");
  cleanup_kill_calls++;
  return 0;
}

static void write_text(const char *path, const char *text) {
  int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  size_t length = strlen(text);
  if (descriptor < 0 || write(descriptor, text, length) != (ssize_t)length ||
      close(descriptor) != 0)
    unit_fail("fixture write");
}

static void reset_scope(void) {
  if (counter_fd >= 0)
    close(counter_fd);
  if (directory_fd >= 0)
    close(directory_fd);
  write_text(counter_path, "usage_usec 150\nuser_usec 100\nsystem_usec 50\n");
  write_text(membership_path, "0::/\n");
  directory_fd = open(unit_directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  counter_fd = open(counter_path, O_RDONLY | O_CLOEXEC);
  if (directory_fd < 0 || counter_fd < 0 ||
      fstat(directory_fd, &directory_identity) != 0 ||
      fstat(counter_fd, &counter_identity) != 0)
    unit_fail("fixture pin");
  phase = 1;
  owner_pid = 1;
  last_usage = 100;
}

static void expect_rejected(const char *label, int expected) {
  uint64_t usage_value = 123, device = 456, inode = 789;
  int result = takosumi_meter_sample(&usage_value, &device, &inode);
  if (result != -expected || phase != 2 || usage_value != 123 || device != 456 ||
      inode != 789 || takosumi_meter_sample(&usage_value, &device, &inode) >= 0 ||
      takosumi_meter_init() >= 0)
    unit_fail(label);
  int previous_kills = cleanup_kill_calls;
  if (takosumi_meter_kill_owned() != 0 || cleanup_kill_calls != previous_kills + 1 ||
      takosumi_meter_drain() != 0 || takosumi_meter_close() != -ENODATA || phase != 3)
    unit_fail("source failure retains cleanup but refuses successful close");
  counter_fd = directory_fd = -1;
  tests++;
}

int main(void) {
  strcpy(unit_directory, "/tmp/takosumi-native-guards-XXXXXX");
  if (mkdtemp(unit_directory) == NULL)
    unit_fail("temporary directory");
  snprintf(membership_path, sizeof(membership_path), "%s/membership", unit_directory);
  snprintf(counter_path, sizeof(counter_path), "%s/cpu.stat", unit_directory);
  reset_scope();
  uint64_t value, device, inode;
  if (takosumi_meter_sample(&value, &device, &inode) != 0 || value != 150)
    unit_fail("positive parser control");
  tests++;
  reset_scope();
  write_text(counter_path, "usage_usec 99\n");
  expect_rejected("counter reset", ERANGE);
  reset_scope();
  if (unlink(counter_path) != 0)
    unit_fail("counter disappearance setup");
  expect_rejected("counter disappearance", ENOENT);
  reset_scope();
  char replacement[160];
  snprintf(replacement, sizeof(replacement), "%s/replacement", unit_directory);
  write_text(replacement, "usage_usec 200\n");
  if (rename(replacement, counter_path) != 0)
    unit_fail("counter replacement setup");
  expect_rejected("counter replacement", ESTALE);
  reset_scope();
  write_text(membership_path, "0::/different-run\n");
  expect_rejected("membership change", EXDEV);
  const char *invalid[] = {"user_usec 123\n", "usage_usec 12x\n",
                           "usage_usec 150\nusage_usec 151\n", "usage_usec \n",
                           "usage_usec 150", "usage_usec -1\n"};
  for (size_t index = 0; index < sizeof(invalid) / sizeof(invalid[0]); index++) {
    reset_scope();
    write_text(counter_path, invalid[index]);
    expect_rejected("malformed or missing kernel field", EBADMSG);
  }
  reset_scope();
  write_text(counter_path, "usage_usec 18446744073709551616\n");
  expect_rejected("counter integer overflow", EOVERFLOW);
  close(counter_fd);
  close(directory_fd);
  if (unlink(counter_path) != 0 || unlink(membership_path) != 0 ||
      rmdir(unit_directory) != 0)
    unit_fail("cleanup");
  printf("{\"type\":\"syscall-fault-unit-guards\",\"ok\":true,"
         "\"cases\":%d,\"kernelCounterQualification\":false}\n", tests);
  return 0;
}

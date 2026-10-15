#define _GNU_SOURCE
#include "hosted-metered-supervisor.h"
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/capability.h>
#include <linux/magic.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int phase; /* 0 never initialized, 1 ready, 2 unavailable, 3 closed. */
static pid_t owner_pid;
static int directory_fd = -1;
static int counter_fd = -1;
static struct stat directory_identity;
static struct stat counter_identity;
static uint64_t last_usage;

static int dropped_child_identity(void) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
  struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 ||
      getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
      syscall(SYS_capget, &header, capabilities) != 0)
    return -errno;
  if (real_uid != 65534 || effective_uid != 65534 || saved_uid != 65534 ||
      real_gid != 65534 || effective_gid != 65534 || saved_gid != 65534 ||
      getgroups(0, NULL) != 0 || getppid() != 1 ||
      prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1)
    return -EPERM;
  for (size_t index = 0; index < 2; index++)
    if (capabilities[index].permitted != 0 ||
        capabilities[index].effective != 0 ||
        capabilities[index].inheritable != 0)
      return -EPERM;
  for (int capability = 0; capability < 64; capability++) {
    errno = 0;
    int bounding = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
    if (bounding < 0 && errno == EINVAL)
      continue;
    if (bounding != 0 ||
        prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0, 0) != 0)
      return -EPERM;
  }
  errno = 0;
  if (prctl(PR_CAPBSET_READ, 64, 0, 0, 0) >= 0 || errno != EINVAL)
    return -ENOTSUP;
  return 0;
}

int takosumi_meter_child_protected(void) {
  int identity = dropped_child_identity();
  if (identity != 0)
    return identity;
  int death_signal = 0;
  if (prctl(PR_GET_PDEATHSIG, &death_signal, 0, 0, 0) != 0)
    return -errno;
  if (death_signal != SIGKILL || prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0)
    return -EPERM;
  const int debug_signals[] = {SIGUSR1, SIGUSR2};
  for (size_t index = 0; index < sizeof(debug_signals) / sizeof(debug_signals[0]);
       index++) {
    struct sigaction action;
    if (sigaction(debug_signals[index], NULL, &action) != 0)
      return -errno;
    if (action.sa_handler != SIG_IGN)
      return -EPERM;
  }
  return 0;
}

int takosumi_meter_harden_child(void) {
  int identity = dropped_child_identity();
  if (identity != 0)
    return identity;
  struct sigaction action = {.sa_handler = SIG_IGN};
  if (sigemptyset(&action.sa_mask) != 0 ||
      sigaction(SIGUSR1, &action, NULL) != 0 ||
      sigaction(SIGUSR2, &action, NULL) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0)
    return -errno;
  /* Detect parent death or protection changes before accepting a request. */
  int protected = takosumi_meter_child_protected();
  if (protected != 0)
    return protected;
  return 0;
}

static int unavailable(int error) {
  if (phase != 3)
    phase = 2;
  return -(error > 0 ? error : EIO);
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         (left->st_mode & S_IFMT) == (right->st_mode & S_IFMT);
}

static int assert_owner(void) {
  if ((phase != 1 && phase != 2) || owner_pid != getpid() || getpid() != 1 || getuid() != 0 ||
      geteuid() != 0 || prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0)
    return unavailable(EPERM);
  int subreaper = 0;
  if (prctl(PR_GET_CHILD_SUBREAPER, &subreaper, 0, 0, 0) != 0 || subreaper != 1)
    return unavailable(EPERM);
  return 0;
}

static int root_cgroup_membership(void) {
  char data[128];
  int descriptor = open("/proc/self/cgroup", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0)
    return -errno;
  struct statfs filesystem;
  int result = 0;
  if (fstatfs(descriptor, &filesystem) != 0)
    result = -errno;
  else if (filesystem.f_type != PROC_SUPER_MAGIC)
    result = -ENODEV;
  ssize_t length = result == 0 ? read(descriptor, data, sizeof(data)) : -1;
  if (result == 0 && length < 0)
    result = -errno;
  else if (result == 0 &&
           (length != 5 || memcmp(data, "0::/\n", 5) != 0))
    result = -EXDEV;
  if (close(descriptor) != 0 && result == 0)
    result = -errno;
  return result;
}

static int source_identity(void) {
  struct stat current_directory, current_counter, named_directory, named_counter;
  struct statfs filesystem;
  if (fstat(directory_fd, &current_directory) != 0 ||
      fstat(counter_fd, &current_counter) != 0 ||
      fstatat(AT_FDCWD, "/sys/fs/cgroup", &named_directory,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      fstatat(directory_fd, "cpu.stat", &named_counter,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      fstatfs(counter_fd, &filesystem) != 0)
    return -errno;
  if (filesystem.f_type != CGROUP2_SUPER_MAGIC ||
      !same_identity(&directory_identity, &current_directory) ||
      !same_identity(&directory_identity, &named_directory) ||
      !same_identity(&counter_identity, &current_counter) ||
      !same_identity(&counter_identity, &named_counter))
    return -ESTALE;
  return root_cgroup_membership();
}

static int read_usage(uint64_t *usage) {
  char data[4096];
  ssize_t length = pread(counter_fd, data, sizeof(data) - 1, 0);
  if (length < 0)
    return -errno;
  if (length == 0 || length == (ssize_t)sizeof(data) - 1)
    return -EOVERFLOW;
  data[length] = '\0';
  char *line = data;
  int found = 0;
  uint64_t result = 0;
  while (line < data + length) {
    char *end = strchr(line, '\n');
    if (end == NULL)
      return -EBADMSG;
    static const char prefix[] = "usage_usec ";
    if ((size_t)(end - line) >= sizeof(prefix) - 1 &&
        memcmp(line, prefix, sizeof(prefix) - 1) == 0) {
      if (found++)
        return -EBADMSG;
      char *digit = line + sizeof(prefix) - 1;
      if (digit == end)
        return -EBADMSG;
      for (; digit < end; digit++) {
        if (*digit < '0' || *digit > '9')
          return -EBADMSG;
        uint64_t value = (uint64_t)(*digit - '0');
        if (result > (UINT64_MAX - value) / 10)
          return -EOVERFLOW;
        result = result * 10 + value;
      }
    }
    line = end + 1;
  }
  if (found != 1)
    return -EBADMSG;
  *usage = result;
  return 0;
}

int takosumi_meter_init(void) {
  if (phase != 0)
    return unavailable(EALREADY);
  phase = 2;
  if (getpid() != 1 || getuid() != 0 || geteuid() != 0)
    return -EPERM;
  int status;
  errno = 0;
  pid_t child = waitpid(-1, &status, WNOHANG);
  /* Even a reaped preexisting zombie makes this scope non-dedicated. */
  if (child >= 0 || errno != ECHILD)
    return -EBUSY;
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0)
    return -errno;
  int membership = root_cgroup_membership();
  if (membership != 0)
    return membership;
  directory_fd = open("/sys/fs/cgroup", O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                             O_NOFOLLOW);
  if (directory_fd < 0)
    return -errno;
  counter_fd = openat(directory_fd, "cpu.stat", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (counter_fd < 0)
    return -errno;
  if (fstat(directory_fd, &directory_identity) != 0 ||
      fstat(counter_fd, &counter_identity) != 0)
    return -errno;
  int identity = source_identity();
  if (identity != 0)
    return identity;
  int reading = read_usage(&last_usage);
  if (reading != 0)
    return reading;
  owner_pid = getpid();
  phase = 1;
  return assert_owner();
}

int takosumi_meter_sample(uint64_t *usage_usec, uint64_t *device,
                          uint64_t *inode) {
  if (assert_owner() != 0)
    return -EPERM;
  if (phase != 1)
    return -ENODATA;
  if (usage_usec == NULL || device == NULL || inode == NULL)
    return unavailable(EINVAL);
  int identity = source_identity();
  if (identity != 0)
    return unavailable(-identity);
  uint64_t usage;
  int reading = read_usage(&usage);
  if (reading != 0)
    return unavailable(-reading);
  identity = source_identity();
  if (identity != 0)
    return unavailable(-identity);
  if (usage < last_usage)
    return unavailable(ERANGE);
  last_usage = usage;
  *usage_usec = usage;
  *device = (uint64_t)counter_identity.st_dev;
  *inode = (uint64_t)counter_identity.st_ino;
  return 0;
}

int takosumi_meter_drain(void) {
  if (assert_owner() != 0)
    return -EPERM;
  for (;;) {
    int status;
    pid_t child = waitpid(-1, &status, WNOHANG);
    if (child > 0)
      continue;
    if (child == 0)
      return 1;
    if (errno == EINTR)
      continue;
    if (errno == ECHILD)
      return 0;
    return unavailable(errno);
  }
}

int takosumi_meter_kill_owned(void) {
  if (assert_owner() != 0)
    return -EPERM;
  if (kill(-1, SIGKILL) != 0 && errno != ESRCH)
    return unavailable(errno);
  return 0;
}

int takosumi_meter_close(void) {
  int drained = takosumi_meter_drain();
  if (drained != 0)
    return drained > 0 ? -EBUSY : drained;
  int source_unavailable = phase != 1;
  phase = 3;
  int error = 0;
  if (close(counter_fd) != 0)
    error = errno;
  if (close(directory_fd) != 0 && error == 0)
    error = errno;
  counter_fd = directory_fd = -1;
  if (error != 0)
    return -error;
  return source_unavailable ? -ENODATA : 0;
}

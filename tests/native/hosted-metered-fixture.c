#define _GNU_SOURCE
#include "../../runner/native/hosted-metered-supervisor.h"
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/capability.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int failures;
static const char *fixture = "/proof/hosted-metered-fixture";
static const char *launcher = "/proof/hosted-metered-launcher";

static void fatal(const char *operation) {
  fprintf(stderr, "native proof unavailable: %s (%d)\n", operation, errno);
  exit(2);
}

static void checked(int result, const char *operation) {
  if (result != 0) {
    errno = result < 0 ? -result : result;
    fatal(operation);
  }
}

static uint64_t clock_usec(clockid_t clock_id) {
  struct timespec time;
  if (clock_gettime(clock_id, &time) != 0)
    fatal("clock");
  return (uint64_t)time.tv_sec * UINT64_C(1000000) +
         (uint64_t)time.tv_nsec / UINT64_C(1000);
}

static void burn(clockid_t clock_id, uint64_t duration) {
  uint64_t start = clock_usec(clock_id);
  volatile uint64_t value = 1;
  while (clock_usec(clock_id) - start < duration)
    for (int index = 0; index < 5000; index++)
      value = value * UINT64_C(6364136223846793005) + 1;
}

static void *thread_burn(void *ignored) {
  (void)ignored;
  burn(CLOCK_THREAD_CPUTIME_ID, UINT64_C(100000));
  return NULL;
}

static uint64_t usage(void) {
  uint64_t value, device, inode;
  checked(takosumi_meter_sample(&value, &device, &inode), "kernel sample");
  return value;
}

static uint64_t children_cpu(void) {
  struct rusage resource;
  if (getrusage(RUSAGE_CHILDREN, &resource) != 0)
    fatal("diagnostic rusage");
  return (uint64_t)resource.ru_utime.tv_sec * UINT64_C(1000000) +
         (uint64_t)resource.ru_utime.tv_usec +
         (uint64_t)resource.ru_stime.tv_sec * UINT64_C(1000000) +
         (uint64_t)resource.ru_stime.tv_usec;
}

static int open_denied(const char *path, int mode) {
  int descriptor = open(path, mode | O_NONBLOCK | O_CLOEXEC);
  if (descriptor >= 0) {
    close(descriptor);
    return 0;
  }
  return errno == EACCES || errno == EPERM;
}

static void probe(pid_t protected_parent) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
  struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 ||
      getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
      syscall(SYS_capget, &header, capabilities) != 0)
    fatal("probe identity");
  int capabilities_zero = 1;
  int good = real_uid == 65534 && effective_uid == 65534 && saved_uid == 65534 &&
             real_gid == 65534 && effective_gid == 65534 && saved_gid == 65534 &&
             getgroups(0, NULL) == 0 &&
             prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1;
  for (size_t index = 0; index < 2; index++)
    capabilities_zero = capabilities_zero && capabilities[index].permitted == 0 &&
                        capabilities[index].effective == 0 &&
                        capabilities[index].inheritable == 0;
  for (int capability = 0; capability < 64; capability++) {
    errno = 0;
    int bounding = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
    if (bounding < 0 && errno == EINVAL)
      continue;
    capabilities_zero = capabilities_zero && bounding == 0 &&
                        prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0, 0) == 0;
  }
  good = good && capabilities_zero;
  good = good && setresuid(0, 0, 0) < 0 &&
         open_denied("/run/takosumi-native-proof/root-key", O_RDONLY) &&
         open_denied("/proc/1/environ", O_RDONLY) &&
         open_denied("/proc/1/mem", O_RDONLY) &&
         open_denied("/proc/1/fd/0", O_RDONLY) &&
         open_denied("/sys/fs/cgroup/cpu.stat", O_WRONLY) &&
         kill(1, 0) < 0 && getenv("TAKOSUMI_PROOF_ROOT_CANARY") == NULL;
  int inherited = 0;
  for (int descriptor = 3; descriptor < 128; descriptor++) {
    errno = 0;
    if (fcntl(descriptor, F_GETFD) >= 0 || errno != EBADF)
      inherited++;
  }
  good = good && inherited == 0;
  int control = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (control < 0)
    fatal("probe socket");
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, "/run/takosumi-native-proof/control.sock");
  int connected = connect(control, (void *)&address, sizeof(address));
  good = good && connected < 0 && (errno == EACCES || errno == EPERM);
  close(control);
  if (protected_parent > 1) {
    const char *suffixes[] = {"environ", "mem", "fd/0", "fd/1"};
    for (size_t index = 0; index < sizeof(suffixes) / sizeof(suffixes[0]); index++) {
      char path[128];
      snprintf(path, sizeof(path), "/proc/%d/%s", protected_parent,
               suffixes[index]);
      good = good && open_denied(path, O_RDONLY);
      if (index >= 2)
        good = good && open_denied(path, O_WRONLY);
    }
    good = good && ptrace(PTRACE_ATTACH, protected_parent, NULL, NULL) < 0;
    char byte;
    struct iovec local = {.iov_base = &byte, .iov_len = 1};
    struct iovec remote = {.iov_base = (void *)(uintptr_t)0x10000, .iov_len = 1};
    errno = 0;
    ssize_t copied = process_vm_readv(protected_parent, &local, 1, &remote, 1, 0);
    good = good && copied < 0 && errno == EPERM;
    int process_fd = (int)syscall(SYS_pidfd_open, protected_parent, 0);
    if (process_fd < 0)
      fatal("provider pidfd_open");
    errno = 0;
    int stolen_fd = (int)syscall(SYS_pidfd_getfd, process_fd, 0, 0);
    good = good && stolen_fd < 0 && errno == EPERM;
    if (stolen_fd >= 0)
      close(stolen_fd);
    close(process_fd);
    struct stat input, null_input;
    good = good && fstat(STDIN_FILENO, &input) == 0 &&
           stat("/dev/null", &null_input) == 0 && input.st_dev == null_input.st_dev &&
           input.st_ino == null_input.st_ino;
    /* Same-UID signals are allowed. These two must not activate an inspector. */
    good = good && kill(protected_parent, SIGUSR1) == 0 &&
           kill(protected_parent, SIGUSR2) == 0;
    usleep(20000);
  }
  printf("{\"type\":\"postexec-security\",\"protectedBunParent\":%s,"
         "\"ok\":%s,\"allCapabilitiesZero\":%s,\"inheritedFDCount\":%d}\n",
         protected_parent > 1 ? "true" : "false", good ? "true" : "false",
         capabilities_zero ? "true" : "false", inherited);
  exit(good ? 0 : 7);
}

static void workload(const char *mode) {
  if (getuid() != 65534 || geteuid() != 65534)
    fatal("workload UID");
  if (strcmp(mode, "security") == 0)
    probe(1);
  if (strcmp(mode, "sleep") == 0) {
    usleep(250000);
    return;
  }
  if (strcmp(mode, "burn") == 0) {
    burn(CLOCK_PROCESS_CPUTIME_ID, UINT64_C(200000));
    return;
  }
  if (strcmp(mode, "threads") == 0) {
    pthread_t first, second;
    if (pthread_create(&first, NULL, thread_burn, NULL) != 0 ||
        pthread_create(&second, NULL, thread_burn, NULL) != 0 ||
        pthread_join(first, NULL) != 0 || pthread_join(second, NULL) != 0)
      fatal("threads");
    return;
  }
  if (strcmp(mode, "waited-fork") == 0) {
    pid_t child = fork();
    if (child < 0)
      fatal("waited fork");
    if (child == 0) {
      burn(CLOCK_PROCESS_CPUTIME_ID, UINT64_C(200000));
      _exit(0);
    }
    if (waitpid(child, NULL, 0) != child)
      fatal("waited fork wait");
    return;
  }
  if (strcmp(mode, "autoreap-red") == 0) {
    int pipe_fds[2];
    if (pipe(pipe_fds) != 0)
      fatal("autoreap pipe");
    struct sigaction action = {.sa_handler = SIG_IGN};
    if (sigaction(SIGCHLD, &action, NULL) != 0)
      fatal("autoreap ignore");
    pid_t child = fork();
    if (child < 0)
      fatal("autoreap fork");
    if (child == 0) {
      close(pipe_fds[0]);
      burn(CLOCK_PROCESS_CPUTIME_ID, UINT64_C(200000));
      if (write(pipe_fds[1], "x", 1) != 1)
        fatal("autoreap done");
      _exit(0);
    }
    close(pipe_fds[1]);
    char done;
    if (read(pipe_fds[0], &done, 1) != 1)
      fatal("autoreap completion");
    close(pipe_fds[0]);
    usleep(50000);
    return;
  }
  if (strcmp(mode, "double-fork") == 0 ||
      strcmp(mode, "setsid-background") == 0) {
    pid_t child = fork();
    if (child < 0)
      fatal("background fork");
    if (child == 0) {
      if (setsid() < 0)
        fatal("background setsid");
      pid_t grandchild = fork();
      if (grandchild < 0)
        fatal("background second fork");
      if (grandchild == 0) {
        burn(CLOCK_PROCESS_CPUTIME_ID, UINT64_C(200000));
        _exit(0);
      }
      _exit(0);
    }
    if (waitpid(child, NULL, 0) != child)
      fatal("background intermediate wait");
    return;
  }
  if (strcmp(mode, "timeout-escaped") == 0) {
    pid_t child = fork();
    if (child < 0)
      fatal("timeout fork");
    if (child == 0) {
      if (setsid() < 0)
        fatal("timeout setsid");
      burn(CLOCK_PROCESS_CPUTIME_ID, UINT64_C(4000000));
      _exit(0);
    }
    burn(CLOCK_PROCESS_CPUTIME_ID, UINT64_C(4000000));
    return;
  }
  fatal("unknown workload");
}

static pid_t launch(const char *mode) {
  pid_t child = fork();
  if (child < 0)
    fatal("fixture fork");
  if (child != 0)
    return child;
  char *environment[] = {"PATH=/usr/local/bin:/usr/bin:/bin", NULL};
  if (strcmp(mode, "bun-security") == 0) {
    char *arguments[] = {(char *)launcher, "--", "/usr/local/bin/bun",
                         "--no-env-file", "/proof/hosted-metered-bun.ts", NULL};
    execve(launcher, arguments, environment);
  } else {
    char *arguments[] = {(char *)launcher, "--", (char *)fixture, "workload",
                         (char *)mode, NULL};
    execve(launcher, arguments, environment);
  }
  _exit(126);
}

static void run_case(const char *mode) {
  uint64_t before = usage(), diagnostic_before = children_cpu();
  uint64_t start = clock_usec(CLOCK_MONOTONIC);
  pid_t child = launch(mode);
  int timed_out = 0, bad_exit = 0;
  for (;;) {
    int status;
    pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) {
      if (strcmp(mode, "timeout-escaped") != 0 &&
          (!WIFEXITED(status) || WEXITSTATUS(status) != 0))
        bad_exit = 1;
      break;
    }
    if (waited < 0 && errno != EINTR)
      fatal("direct child wait");
    if (strcmp(mode, "timeout-escaped") == 0 && !timed_out &&
        clock_usec(CLOCK_MONOTONIC) - start > UINT64_C(120000)) {
      checked(takosumi_meter_kill_owned(), "owned PID namespace kill");
      timed_out = 1;
    }
    if (clock_usec(CLOCK_MONOTONIC) - start > UINT64_C(5000000))
      fatal("direct child timeout pending");
    usleep(1000);
  }
  for (;;) {
    int drained = takosumi_meter_drain();
    if (drained == 0)
      break;
    if (drained < 0)
      checked(drained, "adopted child drain");
    if (clock_usec(CLOCK_MONOTONIC) - start > UINT64_C(5000000))
      fatal("adopted child timeout pending");
    usleep(1000);
  }
  uint64_t consumed = usage() - before;
  uint64_t diagnostic = children_cpu() - diagnostic_before;
  int good = !bad_exit;
  if (strcmp(mode, "sleep") == 0)
    good = good && consumed < UINT64_C(90000);
  if (strcmp(mode, "burn") == 0 || strcmp(mode, "threads") == 0 ||
      strcmp(mode, "waited-fork") == 0 || strcmp(mode, "double-fork") == 0 ||
      strcmp(mode, "setsid-background") == 0)
    good = good && consumed >= UINT64_C(180000);
  if (strcmp(mode, "autoreap-red") == 0)
    good = good && consumed >= UINT64_C(180000) &&
           diagnostic < UINT64_C(70000) && consumed > diagnostic + UINT64_C(120000);
  if (strcmp(mode, "timeout-escaped") == 0)
    good = good && timed_out && consumed > UINT64_C(10000);
  printf("{\"type\":\"case\",\"name\":\"%s\",\"ok\":%s,"
         "\"kernelCpuUsec\":%" PRIu64 ",\"diagnosticRusageUsec\":%" PRIu64
         ",\"drainedECHILD\":true}\n",
         mode, good ? "true" : "false", consumed, diagnostic);
  if (!good)
    failures++;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (argc == 3 && strcmp(argv[1], "workload") == 0) {
    workload(argv[2]);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "probe") == 0) {
    char *end;
    long parent = strtol(argv[2], &end, 10);
    if (*end != '\0' || parent <= 1 || parent > INT32_MAX)
      fatal("probe parent identity");
    probe((pid_t)parent);
  }
  if (argc == 2 && strcmp(argv[1], "require-unavailable") == 0)
    return takosumi_meter_init() < 0 && takosumi_meter_harden_child() < 0 ? 0 : 9;
  alarm(35);
  checked(takosumi_meter_init(), "dedicated collector initialization");
  if (mkdir("/run/takosumi-native-proof", 0700) != 0)
    fatal("synthetic root directory");
  int key = open("/run/takosumi-native-proof/root-key",
                 O_RDWR | O_CREAT | O_EXCL, 0600);
  /* Intentionally NOT CLOEXEC: production launcher must close even this FD. */
  if (key < 0 || write(key, "synthetic-non-production-key", 28) != 28)
    fatal("synthetic inherited root descriptor");
  if (setenv("TAKOSUMI_PROOF_ROOT_CANARY", "synthetic-not-a-secret", 1) != 0)
    fatal("synthetic root environment");
  int control = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, "/run/takosumi-native-proof/control.sock");
  if (control < 0 || bind(control, (void *)&address, sizeof(address)) != 0 ||
      chmod(address.sun_path, 0600) != 0 || listen(control, 1) != 0)
    fatal("synthetic root control socket");
  uint64_t initial, device, inode;
  checked(takosumi_meter_sample(&initial, &device, &inode), "initial kernel sample");
  printf("{\"type\":\"ready\",\"counterDevice\":\"%" PRIu64
         "\",\"counterInode\":\"%" PRIu64 "\",\"initialUsec\":%" PRIu64 "}\n",
         device, inode, initial);
  char go;
  if (read(STDIN_FILENO, &go, 1) != 1 || go != 'G')
    fatal("exact owned cgroup not verified by host");
  const char *cases[] = {"security", "bun-security", "sleep", "burn", "threads",
                         "waited-fork", "autoreap-red", "double-fork",
                         "setsid-background", "timeout-escaped"};
  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++)
    run_case(cases[index]);
  checked(takosumi_meter_close(), "proven drained collector close");
  uint64_t rejected_usage = UINT64_C(123), rejected_device = UINT64_C(456),
           rejected_inode = UINT64_C(789);
  int closed_rejected =
      takosumi_meter_sample(&rejected_usage, &rejected_device, &rejected_inode) < 0 &&
      rejected_usage == UINT64_C(123) && rejected_device == UINT64_C(456) &&
      rejected_inode == UINT64_C(789) && takosumi_meter_init() < 0;
  if (!closed_rejected)
    failures++;
  printf("{\"type\":\"summary\",\"failures\":%d,"
         "\"allOwnedChildrenDrained\":true,\"closedSampleRejected\":%s,"
         "\"cloudflareQualified\":false,\"newImageBuilt\":false}\n",
         failures, closed_rejected ? "true" : "false");
  return failures == 0 ? 0 : 1;
}

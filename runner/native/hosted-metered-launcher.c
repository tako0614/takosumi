#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

/* Build statically: a provider-controlled LD_PRELOAD must never run as root. */
static const uid_t workload_uid = 65534;
static const gid_t workload_gid = 65534;

static void unavailable(const char *operation) {
  int error = errno;
  fprintf(stderr, "hosted metered workload isolation unavailable: %s (%d)\n",
          operation, error);
  _exit(125);
}

static void require(int condition, const char *operation) {
  if (!condition) {
    errno = EPERM;
    unavailable(operation);
  }
}

static void verify_root_owned_nonsetuid_launcher(void) {
  int descriptor = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
  struct stat status;
  if (descriptor < 0 || fstat(descriptor, &status) != 0)
    unavailable("launcher identity");
  require(S_ISREG(status.st_mode) && status.st_uid == 0 &&
              (status.st_mode & (S_ISUID | S_ISGID | S_IWGRP | S_IWOTH)) == 0,
          "root-owned nonsetuid launcher");
  if (close(descriptor) != 0)
    unavailable("launcher identity close");
}

static void verify_dropped_ids_and_capabilities(void) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
  struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 ||
      getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
      syscall(SYS_capget, &header, capabilities) != 0)
    unavailable("dropped identity readback");
  require(real_uid == workload_uid && effective_uid == workload_uid &&
              saved_uid == workload_uid && real_gid == workload_gid &&
              effective_gid == workload_gid && saved_gid == workload_gid &&
              getgroups(0, NULL) == 0 &&
              prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1,
          "dropped identity");
  for (size_t index = 0; index < 2; index++)
    require(capabilities[index].permitted == 0 &&
                capabilities[index].effective == 0 &&
                capabilities[index].inheritable == 0,
            "cleared capability sets");
  for (int capability = 0; capability < 64; capability++) {
    errno = 0;
    int bounding = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
    if (bounding < 0 && errno == EINVAL)
      continue;
    require(bounding == 0, "cleared bounding capabilities");
    int ambient =
        prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0, 0);
    require(ambient == 0, "cleared ambient capabilities");
  }
  errno = 0;
  int unsupported = prctl(PR_CAPBSET_READ, 64, 0, 0, 0);
  require(unsupported < 0 && errno == EINVAL,
          "known Linux capability ABI width");
}

int main(int argc, char **argv) {
  if (argc < 3 || argv[1][0] != '-' || argv[1][1] != '-' ||
      argv[1][2] != '\0' || argv[2][0] == '\0') {
    fprintf(stderr, "usage: hosted-metered-launcher -- command [argument ...]\n");
    return 125;
  }
  uid_t real_uid, effective_uid, saved_uid;
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0)
    unavailable("root identity readback");
  require(real_uid == 0 && effective_uid == 0 && saved_uid == 0,
          "root collector identity");
  verify_root_owned_nonsetuid_launcher();
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0)
    unavailable("launcher dump protection");
  for (int capability = 0; capability < 64; capability++) {
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL)
      unavailable("bounding capability drop");
  }
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
    unavailable("ambient/no-new-privileges protection");
  if (setgroups(0, NULL) != 0 ||
      setresgid(workload_gid, workload_gid, workload_gid) != 0 ||
      setresuid(workload_uid, workload_uid, workload_uid) != 0)
    unavailable("workload identity drop");
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
  struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, capabilities) != 0)
    unavailable("permitted/effective/inheritable capability drop");
  verify_dropped_ids_and_capabilities();
  /* This is deliberately mandatory; an unknown inherited FD is not acceptable. */
  if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0)
    unavailable("inherited descriptor close");
  /* The caller supplies an explicit workload-only environment to Bun.spawn. */
  execvp(argv[2], &argv[2]);
  unavailable("workload exec");
}

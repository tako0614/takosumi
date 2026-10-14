#ifndef TAKOSUMI_HOSTED_METERED_SUPERVISOR_H
#define TAKOSUMI_HOSTED_METERED_SUPERVISOR_H

#include <stdint.h>

/*
 * Linux-only primitives for one dedicated root PID 1. The Bun composition owns
 * Run/boot authority, exclusive enrollment, authentication, and durable receipts.
 * This library does not qualify a provider policy or a commercial meter scope.
 * All failures are negative errno values; no failure returns a zero measurement.
 */
int takosumi_meter_init(void);

/*
 * First trusted code in the real post-exec Bun runner child. Verifies the fixed
 * dropped identity and NNP, then makes its memory/proc FDs non-dumpable before
 * any provider can exist. Parent must still be the root collector PID 1.
 */
int takosumi_meter_harden_child(void);
/* Readback only, suitable before each trusted child request. */
int takosumi_meter_child_protected(void);

/* Pinned kernel usage_usec plus the actual cpu.stat device/inode identity. */
int takosumi_meter_sample(uint64_t *usage_usec, uint64_t *device, uint64_t *inode);

/*
 * Call only after Bun has awaited all tracked direct children. Reaps adopted
 * zombies; returns 0 only for ECHILD, 1 for live children, or negative errno.
 */
int takosumi_meter_drain(void);

/*
 * SIGKILL only inside this initialized, dedicated PID 1 namespace. Cleanup stays
 * available after a source failure, while sampling remains permanently refused.
 */
int takosumi_meter_kill_owned(void);

/*
 * Refuses while children remain; closed/unavailable cannot reinitialize. After
 * source-unavailable cleanup, closes FDs but returns -ENODATA (pending custody).
 */
int takosumi_meter_close(void);

#endif

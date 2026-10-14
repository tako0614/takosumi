import { dlopen, FFIType, ptr } from "bun:ffi";

const NATIVE_LIBRARY = "/app/runner/native/hosted-metered-supervisor.so";

/** The immutable profile owns this path; there is no env-selected library. */
export function openHostedMeteredNative() {
  return dlopen(NATIVE_LIBRARY, {
    takosumi_meter_init: { args: [], returns: FFIType.i32 },
    takosumi_meter_harden_child: { args: [], returns: FFIType.i32 },
    takosumi_meter_child_protected: { args: [], returns: FFIType.i32 },
    takosumi_meter_sample: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32,
    },
    takosumi_meter_drain: { args: [], returns: FFIType.i32 },
    takosumi_meter_kill_owned: { args: [], returns: FFIType.i32 },
    takosumi_meter_close: { args: [], returns: FFIType.i32 },
  });
}

export interface HostedMeteredCpuSample {
  readonly usageUsec: bigint;
  readonly device: bigint;
  readonly inode: bigint;
}

export function sampleHostedMeteredCpu(
  native: ReturnType<typeof openHostedMeteredNative>,
): HostedMeteredCpuSample {
  const values = new BigUint64Array(3);
  if (native.symbols.takosumi_meter_sample(ptr(values), ptr(values, 8), ptr(values, 16)) !== 0) {
    throw new Error("hosted metered kernel counter unavailable");
  }
  return { usageUsec: values[0]!, device: values[1]!, inode: values[2]! };
}

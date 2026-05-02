import { registerProviderErrorClassifier } from "takosumi-contract";
import { classifyAwsErrorAsProviderCategory } from "./aws/support.ts";
import {
  classifyCloudflareErrorAsProviderCategory,
} from "./cloudflare/errors.ts";
import { classifyGcpErrorAsProviderCategory } from "./gcp/_runtime.ts";
import { classifyK8sErrorAsProviderCategory } from "./k8s/errors.ts";

export function registerAwsProviderErrorClassifier(): void {
  registerProviderErrorClassifier("aws", classifyAwsErrorAsProviderCategory);
}

export function registerCloudflareProviderErrorClassifier(): void {
  registerProviderErrorClassifier(
    "cloudflare",
    classifyCloudflareErrorAsProviderCategory,
  );
}

export function registerGcpProviderErrorClassifier(): void {
  registerProviderErrorClassifier("gcp", classifyGcpErrorAsProviderCategory);
}

export function registerK8sProviderErrorClassifier(): void {
  registerProviderErrorClassifier("k8s", classifyK8sErrorAsProviderCategory);
  registerProviderErrorClassifier(
    "kubernetes",
    classifyK8sErrorAsProviderCategory,
  );
}

export function registerBundledProviderErrorClassifiers(): void {
  registerAwsProviderErrorClassifier();
  registerCloudflareProviderErrorClassifier();
  registerGcpProviderErrorClassifier();
  registerK8sProviderErrorClassifier();
}

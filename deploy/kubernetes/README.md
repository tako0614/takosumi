# Takos Kubernetes Provider Runbook

This directory documents the Kubernetes surface as **operator-owned scope**: the operator-attached provider package (`packages/kubernetes-providers/`) and runtime-agent connectors (`packages/runtime-agent/src/connectors/kubernetes/`) provide Kubernetes lifecycle coverage when the operator wires them into their distribution. The deploy artifact (the Helm chart / kustomize overlay / Argo CD manifests that land the Takosumi kernel image and runtime-agent image on a Kubernetes cluster) is also the operator's responsibility. Operators provide the production-grade Kubernetes deploy artifact for their distribution.

## Why no reference Helm chart

The two reference distributions Takosumi ships (`deploy/cloudflare/` and `deploy/single-host/`) cover the substrate-neutrality claim at spec level. Kubernetes is an operator-owned target: operators deploy the kernel image (from `deploy/single-host/Dockerfile.kernel`) and the runtime-agent image (from `deploy/single-host/Dockerfile.runtime-agent`) using their existing GitOps / Helm / kustomize tooling, then attach the Kubernetes provider factory from `@takos/takosumi-kubernetes-providers` plus matching runtime-agent credentials.

## Required runtime shape

The k8s connector talks to the kube-apiserver via REST. It expects:

- A `KUBECONFIG` mounted into the runtime-agent pod, OR
- An in-cluster service account with cluster-wide apply permissions (or namespace-scoped if the runtime-agent only deploys into one namespace).
- A Postgres database for kernel state (`TAKOSUMI_DATABASE_URL` — any in-cluster Postgres operator or external managed Postgres).

## Recommended topology

```
 Ingress (cert-manager + ingress-nginx)
               │
               ▼
     kernel Deployment (replicas: 2+)
               │
               ▼
runtime-agent Deployment (replicas: 1+)
               │
               ▼
   kube-apiserver  ──  user workloads (Deployments, Services, Ingress)
```

State lives in a separate Postgres instance (Zalando Postgres operator, CrunchyData, or external managed Postgres).

## Smoke check

```sh
kubectl run takosumi-smoke --image=...your-kernel-image... \
  --env=TAKOSUMI_DATABASE_URL=...
kubectl exec -it takosumi-smoke -- curl http://localhost:8788/healthz
```

## Substrate-neutral references

The kernel and runtime-agent images in `deploy/single-host/` are substrate-neutral and ready to run on any Kubernetes distribution. The kernel reads env via the `RuntimeAdapter`; cluster configuration stays runtime-neutral. The image base is the Deno runtime today, or a Node image once the Node bundle path is wired through CI.

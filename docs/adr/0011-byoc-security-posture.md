# BYOC security posture: runner-in-cluster pull model, credentials never leave the cluster

BYOC Kubernetes testing follows the GitLab-Runner/Argo-CD-agent pattern: an org-applied runner runs inside the customer's cluster under a namespaced ServiceAccount + Role (never a ClusterRole), dials outbound-only to pull work, and pushes evidence bundles out — the control plane never holds kubeconfigs or any cluster credential and never needs inbound reachability into the cluster. `k8s-attach` (attach to what the org already deployed: port-forward profiles, traffic-borrow via mirrord) ships before any k8s-orchestrate capability — trust is sequenced: prove "attach and produce honest evidence" first, earn build/deploy privilege second.

## Consequences

The runner deletes only resources it created and labeled itself (`proofbench.dev/managed=true`); org-owned workloads are never touched on teardown. The longer-term "we build+deploy+test inside your cluster" story is deliberately absent from v1 and must be messaged as coming, not implied as shipped.

# Provenance ladder: discover→generate, truth per rung

A runtime→PR binding is only green at a **verified signed attestation**; every weaker signal is named as a lesser rung, never treated as proof. Because discovery alone caps most teams below green, `pb` also ships a **generate** path that stamps a verifiable attestation at build time to reach the top rung for the long tail.

**Empirical evidence (kill-test E2, 2026-07-10):** unsigned provenance is trivially forgeable. A single `docker build --label` flips the recorded revision; an unsigned SLSA blob was hand-typed in eight lines; honest and forged images were **indistinguishable** under `docker buildx imagetools inspect`, and `gh attestation verify` 404'd on both (no signed attestation present either way). The redcat sample confirmed the real-world shape: images carry OCI `revision` + `source` labels plus an unsigned BuildKit SLSA blob, resolvable only via a registry hop, with no signed attestation at all.

**The binding is two hops.** *Hop A* (runtime → image digest) is solid: the digest is the Kubernetes `imageID` on the running pod. *Hop B* (digest → source commit) is the crux, and its trustworthiness is exactly the rung the evidence earns:

- **R4 — verified signed attestation** (cosign / Sigstore via Fulcio + Rekor, or GitHub `attest-build-provenance`), verified against a **pinned trust anchor** ⇒ **TRUSTED / green**.
- **R3 — unsigned build-provenance** (BuildKit SLSA blob) ⇒ **CLAIMED-UNVERIFIED**.
- **R2 — OCI label** (`org.opencontainers.image.revision` / `source`) ⇒ **UNVERIFIED**.
- **R1 — tag only** ⇒ **UNTRUSTED**.
- **R0 — none** ⇒ **UNPROVEN**.

**Green is reachable only at verified R4.** Since discovery caps most teams at R3, the **generate** path — a build-time stamp reusing GitHub `attest-build-provenance` or cosign — is the supported route to R4 for teams that don't already sign. Verification needs a **two-scope attach**: cluster-read (for Hop A's `imageID`) plus registry-read (to fetch and verify the attestation for Hop B).

## R4 verification (LANDED, 2026-07-10)

R4 is implemented in `pb verify`: when a provenance claim is in scope (`--owner` + `--signer-workflow` supplied, plus a deployed image digest — the k8s-attach `image.<name>` `imageID` pin, or `--image`), `pb` shells `gh attestation verify oci://<img>@<digest> --owner <org> --signer-workflow <expected>`. A pass sets rung **R4** (TRUSTED); an unattested digest or a wrong signer degrades to **R3** (CLAIMED-UNVERIFIED); no resolvable image is **R0**; `gh` absent is R3 (honest cap, never a fake R4). The rung is recorded on the bundle (`provenanceRung`), and **L4/L5 require R4 when a provenance claim is in scope** — a sub-R4 rung caps the proof ladder at L3, so effect/end-to-end verdicts never stand on an unverified runtime→source binding. Verification pins the signer **out-of-band** (verifier-supplied), never a value read from the image or registry.

**PoC evidence (image `ghcr.io/0prodigy/pb-ci-trust-poc`, 2026-07-10).** `gh attestation verify` PASSES the genuine attestation with `--signer-workflow 0prodigy/proofbench-ci-trust-poc/.github/workflows/build-attest.yml@refs/heads/main` and FAILS (exit 1) on a wrong `--signer-workflow` pin or an unattested digest — reproduced by pb's live integration test (`-tags live`). `gh attestation verify` works through a local egress proxy even when a `rekor.sigstore.dev` MITM breaks the tlog lookup, because the identity binding is in the offline-verifiable Fulcio cert.

**Shell-out, not embedded (ADR-0012 capability).** Verification shells out to `gh attestation verify` / `cosign` (matching kubectl/playwright), not linked `sigstore-go`; the tool absent or the tlog unreachable degrades honestly to a lesser rung, never a fake R4.

## Considered Options

- **Trust OCI labels or the unsigned BuildKit SLSA blob as source proof.** Rejected: E2 forged both in minutes and they were byte-indistinguishable from honest ones under standard tooling — an unsigned claim is not provenance.
- **Use a GitOps `sync.revision` (Argo/Flux) as the source commit.** Rejected: it proves which *manifests* commit was synced, not which *application source* commit produced the running image — the wrong hop.
- **Discovery-only, no generate path.** Rejected: it strands the long tail permanently at R3 with no route to green; shipping the build-time stamp is what makes verified-R4 attainable rather than aspirational.

## Consequences

- The ladder's rung names (TRUSTED / CLAIMED-UNVERIFIED / UNVERIFIED / UNTRUSTED / UNPROVEN) become part of the verdict surface; only R4 sets green, so most first-run bindings will honestly report R2–R3 until a team adopts generate.
- Attach must carry a registry-read scope in addition to cluster-read (ADR-0017), and a pinned trust anchor becomes configuration the runner needs to verify against.
- The generate path reuses existing, blessed tooling (GitHub `attest-build-provenance` / cosign) rather than inventing a signature format — consistent with ADR-0007's build-on-OSS-stack posture.
- Combined with ADR-0015, provenance evidence collected by the harness at R4 is promoting; agent-supplied or unsigned provenance is not.

## No-image anchored ≥L4 is acceptable (DECIDED, 2026-07-10)

An anchored run on a no-image substrate (local/compose — no `image.<name>` pins) can reach ≥L4 even though no R4 image→source binding was verified, because `requireR4` is gated on `exposesDeployedImage`. This is **deliberate, not a hole**, and we keep the gate as-is rather than forcing R4 (or a `--no-image-justification` waiver) on every ≥L4 claim:

- **The re-pointing attack this ADR worried about is closed elsewhere.** The reviewer's concrete attack was editing a genuinely-anchored bundle to point at a malicious source/image/claim while the seal still verified. The honesty-spine `manifestDigest` fix folds **claim, pins (repo commit + every `image.<name>` digest), surface (substrate/cluster/env), each check's level/observed, and each artifact's provenance/type/name** into the sealed digest — so any such swap now breaks the seal. Tamper-evidence, not an R4 gate, is what defeats re-pointing.
- **R4 is only meaningful when a deployed image exists.** Hop A/B bind a *deployed OCI artifact* to its source. On a no-image substrate there is no such artifact to diverge from source: the runtime **is** the pinned checkout (the `repo` git-SHA pin) and the check set is locked and keyless-signed under a CI OIDC identity the agent cannot assume (ADR-0015). Forcing R4 on a no-image run would make ≥L4 *unsatisfiable* there, not more honest.
- **Local without OIDC is already capped.** A local run with no externally-anchored signer stays SELF-ATTESTED and is capped at L3 (ADR-0015); only a genuinely anchored lock lifts that cap. So a no-image ≥L4 is only reachable when the run is anchored to an identity the agent could not forge.
- **The existing acceptance gates encode this intent** (`TestAnchoredVerifyAcceptance`, `TestReducedAssuranceCapsBelowL5`): an anchored local run reaches L4/L5. Enforcing R4 regardless of substrate would contradict them without adding real assurance.

Net: `requireR4` stays coupled to `exposesDeployedImage`. When an image *is* exposed, ≥L4 still requires verified R4 (and `--image` is additive to the substrate's real pins, so a decoy attested image cannot mask an unattested deployed one).

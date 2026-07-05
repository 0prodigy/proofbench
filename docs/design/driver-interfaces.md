# Driver interfaces — generalizing v0 into ADR-0005's pluggable families

Status: proposed · 2026-07-06 · Grounds: ADR-0005/0008/0009/0012; internal/substrate/{types,local,compose}.go;
internal/verify/verify.go; internal/evidence/{core,run,assert}.go; docs/research/{docker-mode,k8s-mode,
peekaboo-computer-use,agent-abstraction}.md. Sketches are contracts, not implementations.
Per ADR-0012 every driver shells out to external binaries; nothing here links a runtime in.

## 1. The pattern: one family = one package = one small frozen interface + one `New` selector

`substrate.New(kind, dir)` (internal/substrate/types.go:33) is the registry idiom for every family.
No generic registration framework, no plugin loading (ADR-0012): a family's registry is its package's
`New` switch plus a `Kinds()` list for preflight and error text. Four families:

| Family      | Package                     | Kinds (v1)                              | Runs            |
|-------------|-----------------------------|-----------------------------------------|-----------------|
| Substrate   | internal/substrate (exists) | local, compose, + k8s-attach            | whole run       |
| CheckDriver | internal/checkdriver (new)  | exec (default), playwright, computer-use| per check       |
| Builder     | internal/build (new)        | external (shape A), buildkit (shape B)  | before Up       |
| AuthProvider| internal/auth (new)         | basic, apikey, cookie                   | per identity/run|

## 2. The one capture seam

Everything any driver observes enters the bundle through `evidence.Capture` — never `*evidence.Bundle`
directly. Provenance and sealing stay uniform because the bundle sets them, not the caller.

```go
// internal/evidence — *Bundle satisfies this.
type Capture interface {
    // Exec = Bundle.Run today (run.go:29): spawn, tee, NN-<name>.log,
    // command artifact, provenance harness, meta{cmd,exitCode,durationSec}.
    Exec(name string, argv []string, shell bool) (exitCode int, err error)
    // File claims a driver-produced file (trace, PNG, video, session-probe
    // log) as an artifact: copied in, sha256'd, provenance tool (ADR-0013).
    // typ is an evidence.Artifact* enum value.
    File(typ, name, srcPath string, meta map[string]any) error
    // Dir is the bundle directory, for pointing external tools' --output at.
    Dir() string
}
```

`Bundle.Add` keeps provenance agent (core.go:195) for operator/agent-supplied files; `File` is a new
sibling method recording `tool` (ADR-0013). `Seal` (core.go:223) is unchanged: files nobody claimed are
swept as agent provenance — the honest downgrade. `File`'s provenance is decided: §9 / ADR-0013.

## 3. CheckDriver

```go
package checkdriver

const (
    KindExec        = "exec"         // extracted from verify.runChecks (verify.go:71)
    KindPlaywright  = "playwright"   // shells to playwright CLI; traces/screenshots via cap.File
    KindComputerUse = "computer-use" // shells to peekaboo CLI --json (macOS 15+); PNG+sidecar via cap.File
)

// Driver exercises one CheckSpec. It never sets check state — verify owns
// tri-state and the proof ladder (verify.go:99,144).
type Driver interface {
    // Preflight: can this driver run here (binary on PATH, TCC grants, ...)?
    // Failure => the check records not-run with this reason (ADR-0012), never
    // fail, never silent pass. Mirrors ComposeUnavailable (compose.go:16).
    Preflight() error
    // Exercise runs spec.Exercise in env, emitting via cap. The int is the
    // exit code (or driver-mapped equivalent) for exitCode() predicates.
    // error = harness failure: the exercise never ran.
    Exercise(spec manifest.CheckSpec, env Env, cap evidence.Capture) (int, error)
}

// Env is what substrate + auth resolved before the driver runs.
type Env struct {
    Dir       string            // repo root
    Endpoints map[string]string // resource/service -> host:port reachable from this process
    Vars      map[string]string // auth material (basic/apikey) injected as env
    Session   string            // validated storageState.json path; "" = none
}

func New(kind, dir string) (Driver, error) // kind "" => KindExec
```

Selection: new `CheckSpec.Driver` field, default exec. verify.runChecks replaces its inline
`ops.Run` call with New(spec.Driver) → Preflight (not-run on error) → Exercise. Expect predicates
still evaluate via Bundle.Assert (assert.go:34): drivers produce artifacts, predicates read them.
Trace/screenshot assertions arrive as assert-grammar extensions, not driver API.

## 4. Substrate: k8s-attach + the Endpoints capability

`Substrate{Up,Ready,Seed,Down}` stays frozen (types.go:19). k8s-attach is a 4th kind in a new
k8sattach.go per k8s-mode.md §7 (Shape A attach-only; Down deletes only proofbench.dev/managed=true).
One new optional capability, discovered by type assertion — never a 5th interface method (ADR-0005):

```go
// Endpoints: how a substrate reports where things are reachable FROM THE PB
// PROCESS. local/compose: identity (locators are already local). k8s-attach:
// Up opens kubectl port-forwards for the service and each Resource.Via["k8s"],
// holds them until Down, returns 127.0.0.1:<forwarded-port>.
type Endpoints interface {
    Endpoint(name string) (hostport string, err error)
}
```

verify resolves `${resources.<name>.host}`-style placeholders (already the EnvSpec convention in
spec/v0/ready.schema.json) through Endpoints, then fills Env.Endpoints. Drivers stay substrate-blind:
they always dial localhost.

## 5. Builder and AuthProvider

```go
package build

const (
    KindExternal = "external" // shape A: resolve tag->digest; require OCI source+revision
                              // annotations else not-run (docker-mode.md §1.1)
    KindBuildKit = "buildkit" // shape B: docker buildx bake; caching per docker-mode.md §2.2
)

// Builder runs before Substrate.Up; output feeds the substrate (compose
// override / k8s image patch) and the bundle's pins — digest, never tag.
type Builder interface {
    Preflight() error
    Build(r *manifest.Ready, cap evidence.Capture) (map[string]string, error) // service -> ref@sha256:...
}

func New(kind, dir string) (Builder, error)
```

```go
package auth

const (
    KindBasic  = "basic"
    KindAPIKey = "apikey"
    KindCookie = "cookie" // Playwright storageState session (ADR-0008)
)

// SecretRef is scheme:locator (env:|file:|sops:|vault:|broker:). Values never
// appear in manifests; the validator rejects inline plaintext (ADR-0008).
type SecretRef string

// Provider turns one manifest identity into per-check material. Raw secrets go
// to process env / 0600 temp files; only session artifacts are bundle-recorded.
type Provider interface {
    Preflight() error
    // Resolve materializes credentials. Cookie kind MUST validate any cached
    // storageState against the identity's validate probe before reuse and
    // re-authenticate on staleness (ADR-0008); the validation exchange is
    // captured via cap so a reused session is itself evidenced.
    Resolve(id manifest.Identity, cap evidence.Capture) (Material, error)
}

type Material struct {
    Vars    map[string]string // -> checkdriver.Env.Vars
    Session string            // -> checkdriver.Env.Session (cookie kind)
}

func New(kind string) (Provider, error)
```

TOTP (ADR-0008) is a SecretRef seed field inside an identity, derived at Resolve time — not a fourth
kind. Irreducible human MFA remains a gates entry → not-run with the gate name.

## 6. ready.yaml deltas — all additive to spec/v0

```yaml
checks:
  - name: login-flow
    driver: playwright        # NEW, optional, default exec
    identity: admin           # NEW, optional, names an auth entry
    exercise: "tests/e2e/login.spec.ts"
    expect: ["exitCode(login-flow)==0"]

auth:                         # NEW top-level block: name -> Identity
  admin:
    kind: cookie
    username: env:PB_ADMIN_USER   # SecretRef — validator rejects raw values
    password: env:PB_ADMIN_PASS
    validate: ":8391/api/me"      # session-reuse probe (Probe vocabulary)
  api: { kind: apikey, header: X-Api-Key, key: env:PB_API_KEY }

build:                        # NEW top-level block: one family = one block
  driver: external            # external (shape A) | buildkit (shape B)
  image: ghcr.io/acme/orders-api           # shape A fields
  # context: . / dockerfile: Dockerfile / cache: {...}   # shape B fields
```

Divergence from docker-mode.md §1.1 (separate artifact:+build: blocks): one block with a driver
selector, consistent with check.driver — one family, one selector. Manifests without these fields
parse and behave exactly as v0 (exec, no auth, no build). DriveVerb.Identity's v0 `env:VAR` form
stays accepted alongside auth-block names. No breaking change.

## 7. Migration from v0

Untouched: internal/report; cmd/pb dispatch; evidence v2 schema (screenshot/recording types exist);
assert grammar (extensions optional). Changed additively: internal/evidence (+File, +Capture);
internal/manifest (+Driver/+Identity/+Auth/+Build, spec/v0 schema, secretRef validation);
internal/verify (driver dispatch); internal/substrate (+k8s-attach, +Endpoints). New packages:
internal/checkdriver, internal/build, internal/auth. Note: manifest/substrate types.go are
frozen-for-builders (CONTRACTS.md); these edits ship as an orchestrator-approved contract revision.

Order — cheapest falsifiable first; examples/basic must pass `pb verify` after every step:
1. Capture seam + exec-driver extraction (pure refactor, zero behavior change — the registry seed).
2. Manifest/schema additive fields + secretRef validator (no consumers yet).
3. AuthProvider basic/apikey/cookie + playwright driver (first real second driver — proves the seam).
4. Builder: external, then buildkit (independent of 3).
5. k8s-attach + Endpoints + placeholder resolution (largest; depends only on 1).

## 8. The three hardest tensions, resolved

**8.1 Driver artifacts vs Bundle.Run's process model.** Run assumes evidence = teed subprocess output;
provenance harness is earned by having spawned the process (run.go:29). Playwright/peekaboo evidence
is files a foreign tool wrote. Bundle.Add brands them agent (core.go:195); leaving them for Seal
brands them agent too (core.go:223) — either way the anti-fabrication flag lies about driver-captured
pixels. Resolution (superseded by ADR-0013: File records `tool`): Capture.File records harness, because the driver (our code, in-binary) chose the
tool, its flags, and its output path within the same run — control equivalent to spawning. Seal stays
the honest downgrade for unclaimed files. Rejected: per-driver sub-bundles (breaks single-manifest
tamper evidence); a third provenance enum value (schema change — see §9).

**8.2 Probe vs check overlap.** run.ready probes and L3 checks can be byte-identical
(examples/basic/ready.yaml:19-24 re-hits /healthz). Keep separate contracts, not one family: a probe
is a substrate-owned gating precondition — polled, boolean, evidence-free, aborts bring-up; a check is
a driver-owned evidence producer — runs once, tri-state, recorded. Unifying either floods bundles with
poll spam or makes bring-up depend on a bundle that does not exist yet (bring-up is the CLI's job,
verify.go:43). The duplication is the product working: L3 re-observes health through the bundle so the
claim is evidenced, not inferred. Share vocabulary (Probe struct, http predicate), never role.

**8.3 Substrate vs driver boundary for k8s port-forwards.** Checks run on the pb host; the service
lives in-cluster. Driver-owned forwards mean every driver grows k8s awareness and kinds multiply per
substrate (exec-k8s, playwright-k8s, ...) — kills family orthogonality. Substrate-owned forwards had
no reporting channel through the frozen interface. Resolution: substrate owns reachability via the
optional Endpoints capability (§4) — forwards open in Up, close in Down, pidfile discipline mirroring
local.go:83, so `pb down` reaps them even on abandoned runs. Drivers always dial localhost. Accepted
cost: a forward dying mid-check surfaces as a named harness failure, not a silent hang.

## 9. Decision needing founder sign-off

Provenance of driver-emitted files (§2, §8.1): does Capture.File record `harness` — widening the
flag's meaning to "harness-directed tool output", zero schema change (recommended) — or do we add a
third enum value `tool` to evidence v2 (sharper honesty; costs spec/v0 schema + Validate + hub/report
handling)? This defines what the product's core anti-fabrication claim means for every non-exec
driver from here on. Everything else in this document extends already-locked ADRs.

**DECIDED 2026-07-06: add the `tool` enum (ADR-0013).** Capture.File records `tool`; §2/§8.1's
widen-`harness` resolution is superseded accordingly.

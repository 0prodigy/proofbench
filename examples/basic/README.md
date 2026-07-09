# basic-orders example

A minimal HTTP service (`go run .`) on port 8391 with `/healthz` and `POST /orders`.
`pb verify` alone does not bring the service up — a cold `pb verify` hits connection
refused. From this directory, run the full sequence to get an L4 evidence bundle
with no Docker required:

```
pb up --substrate local --manifest ready.yaml
pb ready --manifest ready.yaml
pb verify --manifest ready.yaml
```

See [docs/quickstart.md](../../docs/quickstart.md) for the full walkthrough (including seeding and `pb down`).

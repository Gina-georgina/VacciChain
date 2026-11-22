# Container Resource Limits

## Rationale

Limits are set at roughly **2× the observed idle/steady-state peak** for memory and
**realistic burst ceiling** for CPU. This gives each service room to handle traffic
spikes while ensuring a runaway container cannot starve its neighbours on the host.

## Per-service breakdown

| Service | CPU limit | Memory limit | Basis |
|---|---|---|---|
| `frontend` | 0.05 | 32 MB | nginx static file serving; no dynamic computation |
| `backend` | 0.75 | 256 MB | Node.js heap ~80–100 MB at rest; XDR buffer bursts during Soroban calls |
| `python-service` | 0.50 | 128 MB | FastAPI/uvicorn baseline ~60 MB; async httpx fan-out to Horizon |

## OOM kill detection

Docker's `json-file` logging driver captures kernel OOM kill messages.
To monitor in real time:

```bash
# Stream OOM events from all containers
docker events --filter event=oom

# Check if a container was OOM-killed (exit code 137)
docker inspect <container_name> --format '{{.State.OOMKilled}}'
```

To alert on OOM kills in CI/CD or production, pipe `docker events` to your
observability stack (e.g. Datadog, Prometheus `container_oom_events_total`,
or a simple shell watcher):

```bash
docker events --filter event=oom --format '{{.Actor.Attributes.name}}' | \
  while read name; do
    echo "[ALERT] OOM kill: $name at $(date -u +%FT%TZ)"
  done
```

## Public verification API limits

Public verification endpoints (`/api/verify/:id` and `/api/verify/batch`) are
exposed to untrusted clients, so they enforce hard caps on response size and
work per request. This prevents unbounded record histories or batch inputs from
exhausting memory, CPU, or response bandwidth.

### Single record responses

| Limit | Value | Semantics |
|---|---|---|
| Max records per response | 100 | Records beyond the limit are **truncated**; the response includes `truncated: true` and `nextCursor` |
| Default page size | 20 | Applied when no `limit` query parameter is supplied |
| Max `limit` query parameter | 100 | Values above 100 are clamped to 100 (no error) |
| Max serialized response size | 1 MB | If the page would exceed 1 MB, the page is shortened and `truncated: true` is returned |

Pagination is **cursor-based**: clients pass the opaque `nextCursor` value from
the previous response as the `cursor` query parameter. A response with
`truncated: false` (or no `nextCursor`) marks the end of the history. Cursors are
stable for a given record set; clients must not construct or parse them.

### Batch requests

| Limit | Value | Semantics |
|---|---|---|
| Max items per batch request | 50 | Requests with more items are **rejected** with HTTP 413 and `error: "batch_too_large"` |
| Max request body size | 256 KB | Bodies above this are rejected with HTTP 413 before parsing |
| Max concurrent verifications per batch | 10 | Items are processed in bounded-concurrency chunks; results preserve input order |
| Per-item timeout | 5 s | Timed-out items return `status: "timeout"` in their result slot; the batch continues |

Batch responses are **never silently truncated**: every submitted item receives
exactly one result entry, so `results.length` always equals the number of items
accepted. Oversized batches fail fast rather than being partially processed.

### Boundary behaviour

| Input | Behaviour |
|---|---|
| Below limit (e.g. 99 records, 49 batch items) | Full response, `truncated: false` |
| At limit (exactly 100 records, 50 batch items) | Full response, `truncated: false` |
| Above limit (101+ records) | Truncated page + `nextCursor`; remaining records fetched via pagination |
| Above batch limit (51+ items) | HTTP 413 `batch_too_large`; no items processed |

These limits are covered by boundary tests in the backend test suite
(at, below, and above each threshold).

## Adjusting limits

If you observe legitimate OOM kills under normal load, increase the memory limit
in `docker-compose.yml` in 64 MB increments and re-profile. Do not remove limits
entirely — use `reservations` to guarantee a floor and `limits` to cap the ceiling.

# Known Issues

Things we've hit and knowingly deferred. Each entry says what's wrong, how to see it,
and what fixing it would involve, so it can be picked up cold.

Add new entries as they come up. Move an entry to the bottom section when it's fixed.

---

## Visualization

### Heatmap axis indices don't match topology switch names

The FFW heatmap plots `switch_id` against `target_index` (`plots/plotProfiles.js`,
`FFW_PROFILE.heatmap`). Those are the **model's internal switch indices**, which are not
the order the switches are declared in the topology YAML. The axes read "Source Switch" /
"Destination Switch", so they look like they should be `S00`…`S07`.

For `data/topologies/fluid-flow-wan-8-switch.yaml` the mapping is:

| heatmap index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| topology name | S00 | S01 | **S06** | **S07** | **S02** | **S03** | **S04** | **S05** |

Only 0 and 1 happen to coincide. Confirmed by matching each port's
`port_capacity_mbit_per_interval` back to the unique per-link bandwidths in the YAML
(e.g. switch 0 → 2 at 10.0691 Gbps is `S00 → S06`).

**Impact:** anyone reading the heatmap will name the wrong switches. Same applies to
`switch_id` in the switch time plot and parallel coordinates.

**To fix:** expose the index → name ordering (the topology API or the run datasets
endpoint are the natural homes) and label the axes with real names. Needs the model's
numbering to be derived reliably, not guessed — the renumbering happens when CODES builds
its LPs, so the safest source is the model itself rather than re-deriving from the YAML.

### FFW plots hard-code `stats_type: 'vt'`

`FFW_PARAMS` and `FFW_TIME_PARAMS` in `plots/plotProfiles.js` pin the sampling mode to
`vt` (and `vt,rt` for time plots). There's no UI control to change it.

Any FFW run sampled only at GVT renders **empty plots** even though the data is there.
The ingested `perf-opt64`, `perf-opt64-np8` and `perf-opt64-trace` runs are all like this:
`/api/v1/runs/<id>/ffw-switches?stats_type=vt` returns 0 rows, `?stats_type=gvt` returns
tens of thousands.

**To fix:** a stats-type selector, or fall back to whichever mode the run actually has.
The datasets endpoint could report available stats types alongside row counts.

### "Event Heatmap" title is hard-coded

`plots/heatmap.html` has a static title. For FFW runs the panel shows switch-to-switch
port traffic, not events. The title should follow the resolved profile.

### `plotProfileFor` is now dead code

`plots/plotProfiles.js` still exports it, but nothing imports it since the plots moved to
`profileForSlot`. Left in place as the simulation-type-based fallback; remove it if that
fallback is never needed.

---

## API

### Run data endpoints are unpaginated

No `PAGE_SIZE` or pagination class is configured. `/api/v1/runs/<id>/event` for the
ingested `perf-opt64-trace (engine)` run (1,059,149 `EventRecord`s) returns:

```
HTTP 200   bytes: 141,221,079   time: 4.18s
```

141 MB of JSON in one response, before the browser parses it and Plotly renders it.

**To fix:** pagination or server-side downsampling. This gets more likely to bite now that
one run can hold several datasets at once.

---

## Ingestion

### `data_ingest` can't attach files to an existing run

It always creates a new `Run`, unlike `ingest_ffw`, which takes `--run-id`. This is why
the ROSS engine/event-trace data from the `wan-model-vis-testing` runs had to be ingested
as separate `esnet`-type runs rather than joining their FFW counterparts.

**To fix:** copy `ingest_ffw`'s `_get_or_create_run` pattern into `data_ingest`. Small.

### `data_ingest` leaves runs `pending`

`management/commands/data_ingest.py` only marks a run `COMPLETED` when event **and**
simulation **and** model files are all passed in one invocation. Ingesting a subset leaves
a fully-ingested run showing `pending` forever. Runs 9–12 in the demo database are like
this. They still appear in the run list (only `saved` is filtered out), just mislabeled.

Needs rethinking anyway if `--run-id` lands, since files could then arrive incrementally.

### Event trace parser silently drops zero-payload records

`parsers/event_trace_file.py` skips records whose `sample_size` is 0, because there's no
`event_type` to store. Those records still carry valid `source_lp`, `dest_lp` and virtual
times, which is everything the heatmap needs.

Measured on `wan-model-vis-testing/runs/pause-opt`: the file holds 5,949 events, of which
5,534 have a zero-length payload. Only **415** were ingested — 93% dropped, with no
warning. Runs whose events all carry a 4-byte payload (the `perf-opt64*` set) are
unaffected and ingest exactly.

### FFW `analysis-lps.bin` can't be used as a generic `--model-file`

`parsers/model_file.py` only accepts a 56-byte SimpleP2P payload with `flag == 3`. FFW
writes the same 48-byte header and `flag == 3` but with 448-byte switch and 176-byte
terminal payloads, so the parser bails on the first record:

```
WARNING Stopping parse due to invalid payload size: size=176, remaining=481392
```

Result is 0 `ModelRecord`s. The consequence is that the ROSS-profile `networkTime` plot
("Model stats") can't be populated from an FFW run at all — only from SimpleP2P-format
model stats like the ESnet sample in `data/models/`.

---

## Developer experience

### README's Quick Start doesn't mention migrations

`README.md` says `docker compose up -d` then open `localhost:8000`, but nothing in the
compose files runs `migrate`. On a fresh volume that produces:

```
django.db.utils.ProgrammingError: relation "django_site" does not exist
```

Only `DEVELOPMENT.md` mentions `./manage.py migrate`, under the dev-container flow.

**To fix:** add the step to the README, or add an entrypoint to the `django` service that
runs migrations on start.

### Templates are cached in development

Editing a template has no effect until `docker compose restart django`. `.py` and `.js`
files hot-reload normally — templates don't. There's no explicit loader config in
`net_maestro/settings/`, so it's coming from the base settings package. Costs time
whenever someone edits a template and thinks their change didn't apply.

### Pre-existing lint failures

`tox -e lint` fails with 6 errors, all in `net_maestro/core/models/ffw_results.py` and
`net_maestro/core/tasks/ingest_ffw.py` (mostly "replace for loop with `list.extend`").
Verified present on a clean tree. Means lint can't be used as a gate until they're fixed.

Also note `tox -e lint` ignores `{posargs}`, so it always lints the whole tree — you can't
scope it to specific files. Run the ruff binary directly for that.

### No JavaScript test framework

`package.json` has no test script and the repo has no JS tests. All frontend changes are
verified manually. Worth considering given how much analysis-page logic now lives in
`plots/` and `dataStore.js`.

### Duplicate URL patterns

`net_maestro/urls.py` registers these twice:

- `api/v1/topologies/<slug:name>`
- `api/v1/topologies/<slug:name>/simulation-inputs`

Harmless — the first match wins — but confusing and worth deleting.

---

## Fixed

_(nothing yet)_

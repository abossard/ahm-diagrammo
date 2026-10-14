# Signal-state fixture (test only)

Not a shipped example and never rendered into `drawio/examples/`. It exists so every signal state
the parser can actually produce reaches the Draw.io runtime at least once — including `unknown`,
which no shipped inventory authors — and so the glyph/colour pairing is measured on rendered cells
rather than on the generator's own map.

```mermaid
flowchart BT
    probeSig["Latency = 120 ms (healthy)<br/>Error rate = 4 % (degraded)<br/>Saturation = 91 % (unhealthy)<br/>Freshness = n/a (unknown)"] --> probe["Probe service<br/>degraded"]
    probe --> flow["Probe flow<br/>degraded"]
    flow --> root["Workload root<br/>degraded"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    class probeSig blue;
    class probe,flow,root amber;
```

# Long-signal-label fixture (test only)

Not a shipped example. Every shipped signal name is comfortably narrower than the 136px label
column, so containment there is a property of the data rather than of the layout. These names are
authored past the column — one just over it, one that needs three lines, one single unbreakable token, and one long
enough to be ellipsized — so the containment has to be structural to hold.

```mermaid
flowchart BT
    wideSig["Carrier API availability probe east = 99 % (healthy)<br/>Sustained end-to-end checkout completion latency across every region = 4100 ms (unhealthy)<br/>Supercalifragilisticexpialidociousmeasurementidentifier = 7 (degraded)<br/>Sustained end-to-end checkout completion latency across every region and every partner integration tier = 12 m (unknown)"] --> wide["Wide label service<br/>unhealthy"]
    wide --> flow["Wide label flow<br/>unhealthy"]
    flow --> root["Workload root<br/>unhealthy"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef red fill:#fdf3f4,stroke:#d13438;
    class wideSig blue;
    class wide,flow,root red;
```

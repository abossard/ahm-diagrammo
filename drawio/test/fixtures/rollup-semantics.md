# Rollup-semantics fixture (test only)

Not a shipped example and never rendered into `drawio/examples/`. It exists so every branch of the
propagation matrix the shipped inventories do not exercise together reaches the generator at once:
all three impacts, a two-parent worst-of whose parents disagree, an authored `unknown` fed only
Healthy inputs and an authored `standby` fed only Healthy inputs.

```mermaid
flowchart BT
    bad["Bad leaf<br/>unhealthy"] --> std["Standard parent<br/>healthy"]
    bad2["Bad leaf two<br/>unhealthy"] -. "limited<br/>propagation" .-> lim["Limited parent<br/>healthy"]
    bad3["Bad leaf three<br/>unhealthy"] -. "suppressed<br/>propagation" .-> sup["Suppressed parent<br/>healthy"]
    warn["Warning leaf<br/>degraded"] --> split["Worst-of parent<br/>healthy"]
    bad4["Bad leaf four<br/>unhealthy"] --> split
    ok["Good leaf<br/>healthy"] --> unk["Authored unknown<br/>unknown"]
    ok2["Good leaf two<br/>healthy"] --> sby["Authored standby<br/>standby"]

    std --> root["Workload root<br/>healthy"]
    lim --> root
    sup --> root
    split --> root
    unk --> root
    sby --> root

    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    classDef red fill:#faeceb,stroke:#ba0d16;
    classDef grey fill:#f6f6f5,stroke:#c8c6c4;
    classDef purple fill:#f4f0fb,stroke:#8661c5;
    class bad,bad2,bad3,bad4 red;
    class warn amber;
    class ok,ok2,std,lim,sup,split,root green;
    class sby purple;
```

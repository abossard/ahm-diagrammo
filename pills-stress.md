## Pills stress test

Many labeled relationships to verify pills never overlap and always clearly belong to one line.

All supplied example readings and states in this specimen are demonstration data.

```mermaid
flowchart BT
    aSig["m1 = 81% (healthy)<br/>m2 = 220 ms (degraded)"] --> a["Service A<br/>healthy"]
    bSig["m1 = 74% (degraded)<br/>m2 = 6.4% (unhealthy)"] --> b["Service B<br/>degraded"]
    cSig["m1 = 96% (healthy)<br/>m2 = 190 ms (healthy)"] --> c["Service C<br/>healthy"]
    dSig["m1 = 89% (healthy)<br/>m2 = 410 ms (degraded)"] --> d["Service D<br/>healthy"]
    eSig["m1 = 63% (unhealthy)<br/>m2 = 9.2% (unhealthy)"] --> e["Service E<br/>unhealthy"]
    fSig["m1 = 93% (healthy)<br/>m2 = 0.9% (degraded)"] --> f["Service F<br/>healthy"]

    a -->|reads| mid["Middle flow<br/>degraded"]
    b -->|writes| mid
    c -->|caches| mid
    d -->|queries| mid
    e -. "limited propagation" .-> mid
    f -->|streams events to| mid

    shared["Shared dependency<br/>degraded"] -->|used by| mid
    shared -->|also feeds| other["Other flow<br/>healthy"]
    shared -. "suppressed propagation" .-> root["Workload root<br/>degraded"]
    sSig["m1 = 71% (degraded)"] --> shared
    oSig["m1 = 98% (healthy)"] --> other

    mid -->|primary rollup| root
    other -->|secondary rollup with a long label| root

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    classDef red fill:#faeceb,stroke:#ba0d16;
    class aSig,bSig,cSig,dSig,eSig,fSig,sSig,oSig blue;
    class a,c,d,f,other green;
    class b,mid,shared,root amber;
    class e red;
```

# Shop and commerce multi-region health

Real consumer fixture: the `Shop and commerce` card carries a long subtitle
(`active-active · minimum healthy: · min 2 of 3 regions`) on the same row as its
right-aligned status pill. Regression guard for the subtitle-under-pill overlap.

```mermaid
%%| laneLabels: false
flowchart BT
    chkA["Checkout availability<br/>Region A signal"] --> regA["Checkout · Region A<br/>healthy"]
    chkB["Checkout availability<br/>Region B signal"] --> regB["Checkout · Region B<br/>unhealthy"]
    chkC["Checkout availability<br/>Region C signal"] --> regC["Checkout · Region C<br/>healthy"]

    regA --> shop["Shop and commerce<br/>(active-active)<br/>healthy<br/>(minimum healthy:<br/>min 2 of 3 regions)"]
    regB --> shop
    regC --> shop

    repSig["Reporting freshness<br/>signal"] --> reporting["Reporting<br/>(single region)<br/>degraded"]
    logSig["Logistics availability<br/>signal"] --> logistics["Logistics<br/>(single region)<br/>healthy"]

    shop --> root["Contoso E-Shop<br/>healthy"]
    reporting -. "suppressed<br/>propagation" .-> root
    logistics --> root

    classDef blue fill:none,stroke:#4A90D9,stroke-width:3px;
    classDef amber fill:none,stroke:#F5A623,stroke-width:3px;
    classDef green fill:none,stroke:#7ED321,stroke-width:3px;
    classDef red fill:none,stroke:#D0021B,stroke-width:3px;
    class chkA,chkB,chkC,logSig,repSig blue;
    class reporting amber;
    class regB red;
    class regA,regC,shop,logistics,root green;
```

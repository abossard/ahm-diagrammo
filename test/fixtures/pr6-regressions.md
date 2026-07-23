# PR #6 visual-regression fixtures

Faithful copies of the three consumer (well-architected-pr) health-model Mermaid sources that PR #6
visually regressed. They pin the pre-PR6 edge-color and routing semantics the revert restores:
state-colored connectors (never neutral/gray trunks) and clean corridor routing (no cross-row
spaghetti). Do not "simplify" these — they must stay byte-faithful to the consumer's real diagrams.

## add-operational-quality-signals-to-the-workload-model

```mermaid
flowchart BT
    latencySig["Web latency<br/>signal"] --> web["Web frontend<br/>healthy"]
    cpuSig["CPU<br/>signal"] --> app["App hosting<br/>healthy"]
    dbSig["Connection<br/>signal"] --> db["Database<br/>healthy"]
    queueSig["Queue depth<br/>signal"] --> queue["Order queue<br/>healthy"]
    shipSig["Carrier API<br/>signal"] --> ship["Shipping service<br/>healthy"]

    web --> shop["Shop and commerce<br/>healthy"]
    app --> shop
    db --> shop

    queue --> logistics["Logistics<br/>healthy"]
    ship --> logistics

    loadLatSig["Nightly load test<br/>latency signal"] --> load["Load tests<br/>degraded"]
    loadThruSig["Nightly load test<br/>throughput signal"] --> load

    shop --> root["Workload root<br/>healthy"]
    logistics --> root
    load -. "suppressed<br/>propagation" .-> root

    classDef blue fill:none,stroke:#4A90D9,stroke-width:3px;
    classDef amber fill:none,stroke:#F5A623,stroke-width:3px;
    classDef green fill:none,stroke:#7ED321,stroke-width:3px;
    classDef red fill:none,stroke:#D0021B,stroke-width:3px;
    class latencySig,cpuSig,dbSig,queueSig,shipSig,loadLatSig,loadThruSig blue;
    class load amber;
    class root,web,app,db,queue,ship,shop,logistics green;
```

## add-security-signals-to-your-platform-health-model

```mermaid
flowchart BT

    containerSig["Defender for<br/>Containers alerts"] --> defCont["Container<br/>workload protection<br/>degraded"]
    imageSig["Image vulnerability<br/>signal"] --> defCont
    runtimeSig["Runtime threat<br/>signal"] --> defCont

    wafSig["WAF block-rate<br/>+ ruleset signal"] --> waf["Shared WAF<br/>healthy"]
    fwHealthSig["Azure Firewall<br/>FirewallHealth"] --> fw["Shared firewall<br/>healthy"]
    snatSig["SNAT port<br/>utilization signal"] --> fw

    cluster["Kubernetes cluster<br/>healthy"]

    cluster --> root["Platform root<br/>(shared K8s offering)<br/>degraded"]
    defCont -. "limited<br/>propagation" .-> root
    waf --> root
    fw --> root

    classDef blue fill:none,stroke:#4A90D9,stroke-width:3px;
    classDef amber fill:none,stroke:#F5A623,stroke-width:3px;
    classDef green fill:none,stroke:#7ED321,stroke-width:3px;
    classDef red fill:none,stroke:#D0021B,stroke-width:3px;
    class nodeSig,apiSig,etcdSig,containerSig,imageSig,runtimeSig,wafSig,fwHealthSig,snatSig blue;
    class root amber;
    class defCont red;
    class cluster,waf,fw green;
```

## aggregate-health-across-the-workload-portfolio

```mermaid
flowchart BT
    ecom["E-commerce<br/>health model<br/>(app team)<br/>degraded"] -. discovered .-> rule
    inv["Inventory<br/>health model<br/>(app team)<br/>healthy"] -. discovered .-> rule
    loyalty["Loyalty<br/>health model<br/>(app team)<br/>healthy"] -. discovered .-> rule
    onboarding["New app<br/>health model<br/>(auto-added)<br/>healthy"] -. discovered .-> rule

    rule["Discovery rule<br/>tag: health-model=app<br/>degraded"]
    rule -. "limited<br/>propagation" .-> root

    apiSig["API server<br/>availability signal"] --> api["AKS control plane<br/>healthy"]
    sysSig["System node pool<br/>readiness signal"] --> sysPool["System node pool<br/>healthy"]
    userSig["User node pool<br/>capacity signal"] --> userPool["User node pool<br/>degraded"]
    ingressSig["Ingress 5xx<br/>+ cert signal"] --> ingress["Ingress controller<br/>healthy"]

    api --> root
    sysPool --> root
    userPool --> root
    ingress --> root

    root["Platform root<br/>degraded"]

    classDef purple fill:none,stroke:#9013FE,stroke-width:3px;
    classDef blue fill:none,stroke:#4A90D9,stroke-width:3px;
    classDef amber fill:none,stroke:#F5A623,stroke-width:3px;
    classDef green fill:none,stroke:#7ED321,stroke-width:3px;
    class apiSig,sysSig,userSig,ingressSig blue;
    class inv,loyalty,onboarding green;
    class ecom,userPool,root amber;
    class rule purple;
    class api,sysPool,ingress green;
```

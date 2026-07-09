// scene-appservice.mjs — declarative scene for the App Service baseline (zone-redundant, private)
// architecture, recreating the Microsoft reference diagram cleanly. Coordinates are explicit for
// pixel-precise, professional routing (this is how architecture heroes are authored, not auto-layout).

export const scene = {
  title: "Highly available App Service web application",
  subtitle: "Zone-redundant App Service behind Application Gateway, with private endpoints to data, secrets, and storage.",
  width: 1760,
  height: 1180,
  logo: true,

  containers: [
    // Virtual network (outer)
    { id: "vnet", kind: "vnet", x: 360, y: 100, w: 1360, h: 470, label: "Virtual network", icon: "vnet" },
    // subnets
    { id: "agw-subnet", kind: "subnet", x: 384, y: 150, w: 300, h: 400, label: ["Application", "Gateway subnet"], icon: "subnet", badge: "shield" },
    { id: "int-subnet", kind: "subnet", x: 706, y: 150, w: 990, h: 168, label: "App Service integration subnet", icon: "subnet", badge: "shield" },
    { id: "pe-subnet", kind: "subnet", x: 706, y: 338, w: 990, h: 212, label: "Private endpoint subnet", icon: "subnet", badge: "shield" },

    // Region + zones
    { id: "region", kind: "region", x: 720, y: 700, w: 430, h: 320 },
    { id: "zone1", kind: "zone", x: 748, y: 820, w: 118, h: 178, footer: "Zone 1" },
    { id: "zone2", kind: "zone", x: 876, y: 820, w: 118, h: 178, footer: "Zone 2" },
    { id: "zone3", kind: "zone", x: 1004, y: 820, w: 118, h: 178, footer: "Zone 3" },

    // side groups
    { id: "identity", kind: "group", x: 430, y: 700, w: 200, h: 205, label: null },
    { id: "monitoring", kind: "group", x: 410, y: 940, w: 250, h: 190, label: null },
  ],

  nodes: [
    // left actors
    { id: "user", x: 96, y: 250, icon: "user", label: "User", style: "bare" },
    { id: "dns", x: 150, y: 470, icon: "dns", label: ["Private", "DNS zones"], style: "bare" },
    { id: "ddos", x: 400, y: 588, icon: "ddos", label: ["DDoS", "Protection"], style: "bare", iconSize: 30 },

    // App Gateway + WAF (big tile)
    { id: "agw", x: 534, y: 335, icon: "appgw-waf", label: ["Application Gateway", "with Azure Web", "Application Firewall"], w: 150, h: 118, iconSize: 56 },

    // integration subnet
    { id: "vnic", x: 1560, y: 236, icon: "vnic", label: "Virtual interface", w: 116, h: 84 },

    // private endpoints
    { id: "pe-app", x: 852, y: 446, icon: "private-endpoint", label: ["App Service", "private endpoint"] },
    { id: "pe-db", x: 1188, y: 446, icon: "private-endpoint", label: ["Database private", "endpoint"] },
    { id: "pe-cfg", x: 1378, y: 446, icon: "private-endpoint", label: ["Configuration", "private endpoint"] },
    { id: "pe-stg", x: 1568, y: 446, icon: "private-endpoint", label: ["Storage private", "endpoint"] },

    // region contents
    { id: "mi", x: 782, y: 752, icon: "managed-identity", label: ["Managed", "identity"], style: "bare", iconSize: 34 },
    { id: "appsvc", x: 940, y: 748, icon: "appservice", label: "App Service", style: "bare", iconSize: 40 },
    { id: "inst1", x: 807, y: 858, icon: "appservice", label: ["App Service", "instance"], style: "bare", iconSize: 34 },
    { id: "inst2", x: 935, y: 858, icon: "appservice", label: ["App Service", "instance"], style: "bare", iconSize: 34 },
    { id: "inst3", x: 1063, y: 858, icon: "appservice", label: ["App Service", "instance"], style: "bare", iconSize: 34 },

    // backend tiers (gray tiles, group label below)
    { id: "sql", x: 1188, y: 790, icon: "sql", label: ["Azure SQL", "Database"], style: "tile-gray", groupLabel: "Data" },
    { id: "kv", x: 1378, y: 790, icon: "keyvault", label: ["Azure Key", "Vault"], style: "tile-gray", groupLabel: "Certificates" },
    { id: "stg", x: 1568, y: 790, icon: "storage", label: ["Azure", "Storage"], style: "tile-gray", groupLabel: ["Storage for", "deployment"] },

    // identity + monitoring
    { id: "entra", x: 530, y: 762, icon: "entra", label: ["Microsoft", "Entra ID"], style: "bare", iconSize: 40 },
    { id: "appinsights", x: 495, y: 1000, icon: "appinsights", label: ["Application", "Insights"], style: "bare", iconSize: 36 },
    { id: "azmon", x: 590, y: 1000, icon: "monitor", label: ["Azure", "Monitor"], style: "bare", iconSize: 36 },
  ],

  edges: [
    { from: { id: "user", side: "right" }, to: { id: "agw", side: "left" }, via: [[300, 250], [300, 335]] },
    { from: { id: "dns", side: "right" }, to: { id: "agw", side: "left", off: 34 }, dash: "2 4", label: "Linked", labelAt: [300, 452], via: [[300, 470], [300, 369]] },
    { from: { id: "agw", side: "right" }, to: { id: "pe-app", side: "left" }, via: [[770, 335], [770, 446]] },

    // App Service PE -> App Service (region), clean L into the left side
    { from: { id: "pe-app", side: "bottom" }, to: { id: "appsvc", side: "left" }, via: [[852, 748]] },
    // App Service (region) outbound integration -> virtual interface
    { from: { id: "appsvc", side: "top" }, to: { id: "vnic", side: "left" }, via: [[940, 672], [1140, 672], [1140, 236]], r: 10 },
    // virtual interface -> the three data-plane PEs, via a horizontal bus
    { from: { id: "vnic", side: "bottom" }, to: { id: "pe-db", side: "top" }, via: [[1560, 340], [1188, 340]] },
    { from: { id: "vnic", side: "bottom" }, to: { id: "pe-cfg", side: "top" }, via: [[1560, 340], [1378, 340]] },
    { from: { id: "vnic", side: "bottom" }, to: { id: "pe-stg", side: "top" }, via: [[1560, 340], [1568, 340]] },

    // PEs -> backends
    { from: { id: "pe-db", side: "bottom" }, to: { id: "sql", side: "top" } },
    { from: { id: "pe-cfg", side: "bottom" }, to: { id: "kv", side: "top" } },
    { from: { id: "pe-stg", side: "bottom" }, to: { id: "stg", side: "top" } },
  ],

  // extra free text labels (rendered by the CLI wrapper)
  texts: [
    { x: 935, y: 1052, text: "Region", size: 13, weight: 700, anchor: "middle" },
    { x: 530, y: 892, text: "Identity", size: 13, weight: 700, anchor: "middle" },
    { x: 535, y: 1118, text: "Monitoring", size: 13, weight: 700, anchor: "middle" },
  ],
};

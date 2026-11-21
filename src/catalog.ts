// The products this platform offers. Keys, names and repositories match
// contracts/platform.openapi.yaml and docs/product-split-plan.md.

export const PRODUCT_KEYS = ["platform", "procurement", "stores", "sales", "production", "finance"] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

export interface ProductInfo {
  key: ProductKey;
  name: string;
  repository: string;
  status: "available" | "planned";
  catalogIds: string[];
}

export const PRODUCTS: readonly ProductInfo[] = [
  { key: "platform", name: "Platform", repository: "qavril-labs/platform", status: "available", catalogIds: ["PLT-01", "PLT-02", "PLT-06", "PLT-07", "PLT-08", "PLT-16", "PLT-18", "MDM-01", "MDM-02", "MDM-03", "MDM-05"] },
  { key: "procurement", name: "Procurement", repository: "qavril-labs/procurement", status: "available", catalogIds: ["PRC-01", "PRC-02", "PRC-03", "PRC-05", "PRC-06"] },
  { key: "stores", name: "Stores", repository: "qavril-labs/stores", status: "planned", catalogIds: ["INV-01", "INV-02", "INV-03", "INV-04", "INV-05", "INV-07", "INV-10", "PRC-04"] },
  { key: "sales", name: "Sales", repository: "qavril-labs/sales", status: "planned", catalogIds: ["SAL-01", "SAL-02", "SAL-03", "SAL-04"] },
  { key: "production", name: "Production", repository: "qavril-labs/production", status: "planned", catalogIds: ["MFG-01", "MFG-02", "MFG-03", "MFG-04", "MFG-05", "MFG-06", "MFG-13", "MFG-16"] },
  { key: "finance", name: "Finance", repository: "qavril-labs/finance", status: "planned", catalogIds: ["FIN-03", "FIN-04"] },
];

export function isProductKey(value: string): value is ProductKey {
  return (PRODUCT_KEYS as readonly string[]).includes(value);
}

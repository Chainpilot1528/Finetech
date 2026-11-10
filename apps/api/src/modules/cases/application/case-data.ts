import { PRODUCTS, sensitiveFields } from '@vittora/product-schemas';
import { decrypt, encrypt } from '../../../platform/crypto.js';

type Details = Record<string, unknown>;

/**
 * Splits product details so the fields marked sensitive in the product definition are stored
 * encrypted, and the rest stay queryable (SEC-03). The product definition is the one list of which
 * fields are sensitive, so a new product needs no change here.
 */
export function sealDetails(key: string, productCode: string, details: Details | undefined) {
  const product = PRODUCTS[productCode];
  const hidden = new Set(product ? sensitiveFields(product) : []);
  const plain: Details = {};
  const secret: Details = {};
  for (const [k, v] of Object.entries(details ?? {})) (hidden.has(k) ? secret : plain)[k] = v;
  return { plain, sealed: Object.keys(secret).length ? encrypt(key, JSON.stringify(secret)) : null };
}

/** The full details for a screen that is allowed to show them. */
export function revealDetails(key: string, row: { product_details: Details | null; product_details_enc: string | null }): Details {
  return { ...(row.product_details ?? {}), ...(row.product_details_enc ? JSON.parse(decrypt(key, row.product_details_enc)) : {}) };
}

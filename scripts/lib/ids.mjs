/**
 * Deterministic uuid-shaped ids.
 *
 * Stability is the whole point: Kibana keys controls, drilldown events and panel references by
 * id, so an id derived from a random source would churn on every deploy — orphaning a control
 * selection an analyst had made, or duplicating a drilldown each time.
 *
 * The output is uuid-SHAPED rather than a real UUIDv5: version nibble 5, variant nibble a,
 * 8-4-4-4-12. Kibana only requires the shape.
 */
import { createHash } from 'node:crypto';

export function stableUuid(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The audit dashboards, as data — one module per dashboard under ./dashboards/.
 *
 * These build the JSON written to dashboards/*.json and deployed via PUT /api/dashboards/{id}.
 * Panel descriptions are the hover tooltips — they explain what a panel shows AND how to read
 * it, so the suite is usable by someone who did not build it.
 */
import { build as d00_command_center } from './dashboards/00-command-center.mjs';
import { build as d01_identity_access } from './dashboards/01-identity-access.mjs';
import { build as d02_kibana_objects } from './dashboards/02-kibana-objects.mjs';
import { build as d03_data_access } from './dashboards/03-data-access.mjs';
import { build as d04_security_anomalies } from './dashboards/04-security-anomalies.mjs';
import { build as d05_geo_network } from './dashboards/05-geo-network.mjs';
import { build as d06_platform_volume } from './dashboards/06-platform-volume.mjs';
import { build as d07_actor_360 } from './dashboards/07-actor-360.mjs';

import { isDeployed } from './suite.mjs';

const BUILDERS = {
  '00-command-center': d00_command_center,
  '01-identity-access': d01_identity_access,
  '02-kibana-objects': d02_kibana_objects,
  '03-data-access': d03_data_access,
  '04-security-anomalies': d04_security_anomalies,
  '05-geo-network': d05_geo_network,
  '06-platform-volume': d06_platform_volume,
  '07-actor-360': d07_actor_360,
};

/**
 * The dashboards this run deploys, keyed by source name. Insertion order is deploy order and
 * panel-id order; keep it stable. An opt-in dashboard (06 Platform Volume, see lib/suite.mjs) is
 * left out unless AUDIT_WITH names it, and so is every link, drilldown and sentence that would
 * point at it: those read the same set while they build.
 */
export function buildAll() {
  return Object.fromEntries(Object.entries(BUILDERS).filter(([name]) => isDeployed(name)).map(([name, b]) => [name, b()]));
}

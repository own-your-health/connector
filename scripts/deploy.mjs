#!/usr/bin/env node
// Deploys from your computer to the account connector.local.json names.
// GitHub Actions deploys main the same way (README, "Deploying from
// GitHub"); this is for the first deploy, or a household without Actions.

import { wrangler } from './local.mjs';

wrangler(['deploy']);

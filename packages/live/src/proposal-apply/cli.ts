#!/usr/bin/env node
/**
 * proposal-render: the Ghidra script for one group of approved redivivus.app proposals.
 *
 *   proposal-render <proposals.json> <win|mac> <author|*> <true|false> <out.java> [tag] [chunk/size]
 *
 * See render.ts. Run the dry script first (true: every expect checked, nothing written), then the
 * wet one, through execute_script on the writable program.
 */
import { main } from './render.js';

process.exit(main(process.argv.slice(2)));

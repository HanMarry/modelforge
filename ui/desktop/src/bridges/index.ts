/**
 * Preload bridges of the layer C features, combined for `preload.ts` (spec
 * mathmodel-parity-and-beyond, stage 2). Each feature owns its own `bridges/<feature>Bridge.ts`;
 * this file only combines them and belongs to the C0 skeleton (see layer-c-contract-desktop.md).
 */
import type { FeatureApis } from '../types/featureApis';
import { learningBridge } from './learningBridge';
import { paperCheckBridge } from './paperCheckBridge';
import { reviewBridge } from './reviewBridge';
import { runCompareBridge } from './runCompareBridge';
import { runsBridge } from './runsBridge';
import { taskResumeBridge } from './taskResumeBridge';

export const featureBridges: FeatureApis = {
  ...runsBridge,
  ...paperCheckBridge,
  ...runCompareBridge,
  ...taskResumeBridge,
  ...reviewBridge,
  ...learningBridge,
};

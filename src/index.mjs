// Library entry point — `import { bestModel } from '@wecko-ai/modelfit'`.
// The package is both a CLI (bin/modelfit.mjs) and an embeddable library: any local
// AI app can call bestModel() to get THE model to run on the user's machine.

export { bestModel, selectBest } from './best.mjs';
export { getRecommendations } from './engine.mjs';
export { detectHardware, toEngineInput } from './detect.mjs';
export { modelUrl, reportUrl, gpuUrl, SOURCE, BASE } from './links.mjs';

(() => {
  'use strict';

  const engineApi = window.SuperExcelFormulaEngine;
  if (!engineApi?.create) throw new Error('Runtime de cálculo não foi carregado.');

  const originalCreate = engineApi.create.bind(engineApi);
  engineApi.create = data => {
    const previous = window.SuperExcelCalculationRuntime;
    if (previous?.destroy) previous.destroy();
    const runtime = originalCreate(data);
    window.SuperExcelCalculationRuntime = runtime;
    window.dispatchEvent(new CustomEvent('superexcel:calculation-runtime', {
      detail: {
        name: engineApi.engineName,
        version: engineApi.engineVersion,
      },
    }));
    return runtime;
  };
})();

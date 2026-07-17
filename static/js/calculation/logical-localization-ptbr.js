(() => {
  'use strict';

  const ALIASES = Object.freeze({
    'ENAO.DISP': 'ENAODISP',
    'NAO.DISP': 'NAODISP',
    'SE.NAO.DISP': 'SENAODISP',
    'SE.ERRO': 'SEERRO',
    'OU.EXCL': 'OUEXCL',
  });

  function attach() {
    const engineApi = window.SuperExcelFormulaEngine;
    if (!engineApi?.create) return false;
    const probe = engineApi.create([]);
    const prototype = Object.getPrototypeOf(probe);
    probe.destroy?.();
    if (!prototype || prototype.__superExcelLogicalPtBrAttached) return Boolean(prototype);

    const previousEvaluateCall = prototype._evaluateCall;
    if (typeof previousEvaluateCall !== 'function') return false;

    prototype._evaluateCall = function localizedLogicalCall(node, stack) {
      const alias = ALIASES[node?.name];
      return previousEvaluateCall.call(this, alias ? { ...node, name: alias } : node, stack);
    };

    Object.defineProperty(prototype, '__superExcelLogicalPtBrAttached', { value: true });
    return true;
  }

  window.SuperExcelLogicalPtBr = Object.freeze({
    version: 1,
    aliases: ALIASES,
    attach,
  });

  attach();
})();

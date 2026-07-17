(() => {
  'use strict';

  function viewportRange({
    scrollTop = 0,
    scrollLeft = 0,
    viewportHeight = 0,
    viewportWidth = 0,
    rows = 1,
    cols = 1,
    rowHeight = 26,
    cellWidth = 118,
    headerHeight = 28,
    rowHeaderWidth = 48,
    overscanRows = 8,
    overscanCols = 3,
  } = {}) {
    const firstVisibleRow = Math.max(0, Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight));
    const firstVisibleCol = Math.max(0, Math.floor(Math.max(0, scrollLeft - rowHeaderWidth) / cellWidth));
    const visibleRows = Math.ceil(Math.max(0, viewportHeight - headerHeight) / rowHeight) + 1;
    const visibleCols = Math.ceil(Math.max(0, viewportWidth - rowHeaderWidth) / cellWidth) + 1;
    return {
      top: Math.max(0, firstVisibleRow - overscanRows),
      bottom: Math.min(Math.max(0, rows - 1), firstVisibleRow + visibleRows + overscanRows),
      left: Math.max(0, firstVisibleCol - overscanCols),
      right: Math.min(Math.max(0, cols - 1), firstVisibleCol + visibleCols + overscanCols),
      firstVisibleRow,
      firstVisibleCol,
    };
  }

  window.SuperExcelViewport = Object.freeze({ viewportRange });
})();

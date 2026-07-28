(() => {
  'use strict';

  // Non-stETH history is a balance delta, not a protocol reward. The original
  // table renderer uses the generic “Reward” label for the change view, so
  // correct that label after each render without changing the original layout.
  const table = document.getElementById('currencyTable');
  const select = document.getElementById('currencySelect');
  if (!table || !select) return;

  const updateLabel = () => {
    if (select.value.toLowerCase() === 'steth') return;
    table.querySelectorAll('th').forEach((header) => {
      if (header.firstChild?.nodeValue === 'Reward') header.firstChild.nodeValue = 'Change';
    });
  };

  new MutationObserver(updateLabel).observe(table, { childList: true, subtree: true });
  select.addEventListener('change', updateLabel);
  updateLabel();
})();

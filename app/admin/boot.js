'use strict';

// Initial bootstrap
checkAuth();
const initialTab = getTabFromUrl();
switchTab(initialTab, { updateHistory: false });


/* Announced Azure price changes. Update this file when Microsoft changes the list.
   Sources (Oct 2026): Azure Service Health notice; nOps and TrustedTech summaries. */
const RULES = {
  effective: '1. feb. 2027',
  regional: { northeurope: 17, francecentral: 11, francesouth: 11, westeurope: 9, norwayeast: 9, norwaywest: 9, southeastasia: 8 },
  legacyPct: 25,
  // Familie (store bogstaver i størrelsesnavnet) pr. generation. v1 = intet _vN-suffiks.
  legacy: { 1: ['B', 'D', 'DS', 'F', 'G', 'GS', 'L', 'NP', 'HC'], 2: ['A', 'D', 'DS', 'F', 'L'] },
  exemptVmVersions: [7],
  storageExempt: /queue|table|general block blob|standard page blob|transaction optimized|container storage/i,
  interzone: /inter[\s-]?(availability[\s-]?)?zone|inter-?az\b/i
};

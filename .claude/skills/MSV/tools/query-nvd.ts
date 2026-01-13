// Query NVD for recent Wireshark CVEs
const url = "https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=wireshark&pubStartDate=2024-01-01T00:00:00.000&resultsPerPage=50";

const response = await fetch(url);
if (!response.ok) {
  console.log("Error:", response.status, response.statusText);
  const text = await response.text();
  console.log(text.slice(0, 500));
  process.exit(1);
}

const data = await response.json();

console.log(`Total Wireshark CVEs since 2024: ${data.totalResults}\n`);
console.log("CVE ID | CVSS | Severity | Fixed Version");
console.log("-------|------|----------|---------------");

for (const vuln of data.vulnerabilities || []) {
  const cve = vuln.cve;
  const cvss = cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore || "N/A";
  const severity = cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity || "N/A";
  
  // Extract fixed version from configurations
  let fixedVersion = "N/A";
  for (const config of cve.configurations || []) {
    for (const node of config.nodes || []) {
      for (const match of node.cpeMatch || []) {
        if (match.versionEndExcluding) {
          fixedVersion = match.versionEndExcluding;
          break;
        }
      }
    }
  }
  
  console.log(`${cve.id} | ${cvss} | ${severity} | ${fixedVersion}`);
}

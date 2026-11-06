\# IP Intelligence – IPv4 \& IPv6 Lookup and Threat Analysis



A web-based IP intelligence dashboard designed to analyze IPv4 and IPv6 addresses using geolocation, network information, Autonomous System Number (ASN) details, and IP abuse reputation data.



\## Features



\- \*\*IPv4 Lookup:\*\* Retrieve information about IPv4 addresses.

\- \*\*IPv6 Lookup:\*\* Retrieve information about IPv6 addresses.

\- \*\*Bulk IP Lookup:\*\* Analyze multiple IP addresses.

\- \*\*Geolocation:\*\* Display approximate geographic information on a map.

\- \*\*ASN Lookup:\*\* Retrieve Autonomous System information.

\- \*\*Abuse Reputation Check:\*\* Check IP abuse reports using AbuseIPDB integration.

\- \*\*Data Visualization:\*\* Present analysis results through charts.

\- \*\*IP Validation:\*\* Validate IPv4 and IPv6 address formats.



\## Technology Stack



| Component | Technology |

|---|---|

| Frontend | HTML, CSS, JavaScript |

| Backend | Node.js, Express.js |

| IP Validation | Node.js `net` module |

| Charts | Chart.js |

| Maps | Leaflet |

| HTTP Requests | node-fetch |

| Configuration | dotenv |

| Data Exchange | JSON |



\## External Services



\- IP-API

\- IP2Location.io

\- FreeIPAPI

\- BGPView

\- RIPEstat

\- AbuseIPDB



Availability and response details depend on the external providers and their API limits.



\## Project Structure



```text

IP-Intelligence-Project/

│

├── static/

│   └── index.html

│

├── data.csv

├── server.js

├── package.json

├── package-lock.json

├── .gitignore

└── README.md

```



\## Installation and Setup



\### 1. Clone the repository



```bash

git clone https://github.com/omm547/IP-Intelligence-Project.git

```



\### 2. Navigate to the project directory



```bash

cd IP-Intelligence-Project

```



\### 3. Install dependencies



```bash

npm install

```



\### 4. Configure environment variables



Create a `.env` file in the project root:



```env

ABUSEIPDB\_KEY=YOUR\_ABUSEIPDB\_API\_KEY

```



Never upload your actual API key to GitHub.



\### 5. Start the application



```bash

npm start

```



\### 6. Open the dashboard



Visit:



```text

http://127.0.0.1:5000

```



\## Security and Limitations



\- Keep API keys and credentials private.

\- Geolocation results are approximate and do not represent an exact physical address.

\- Abuse reputation results are indicators and should not be treated as definitive proof of malicious activity.

\- External API availability and rate limits may affect results.

\- The application performs IP intelligence lookups; it is not a packet-capture or continuous network-monitoring system.



\## Project Purpose



This project demonstrates the application of web technologies and external IP intelligence services to IPv4 and IPv6 address analysis, network information retrieval, geolocation, and abuse reputation checking.



\## Author



\*\*Omm Prakash Sahoo\*\*



GitHub: \[@omm547](https://github.com/omm547)



\## Repository



\[IP-Intelligence-Project](https://github.com/omm547/IP-Intelligence-Project)


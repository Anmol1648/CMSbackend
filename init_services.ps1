$services = @(
    @{ name = "auth-service"; port = 4001 },
    @{ name = "tenant-service"; port = 4002 },
    @{ name = "admission-service"; port = 4003 },
    @{ name = "student-service"; port = 4004 },
    @{ name = "academic-service"; port = 4005 },
    @{ name = "attendance-service"; port = 4006 },
    @{ name = "finance-service"; port = 4007 },
    @{ name = "exam-service"; port = 4008 },
    @{ name = "hr-payroll-service"; port = 4009 },
    @{ name = "communication-service"; port = 4010 }
)

$basePath = "c:\Users\anmol\Desktop\erp\MainErp\cms\backend\services"

foreach ($svc in $services) {
    $svcPath = "$basePath\$($svc.name)"
    $srcPath = "$svcPath\src"
    
    if (-not (Test-Path $srcPath)) {
        New-Item -Path $srcPath -ItemType Directory -Force | Out-Null
    }

    # Create package.json
    $packageJson = @{
        name = $svc.name
        version = "1.0.0"
        main = "src/index.js"
        scripts = @{
            dev = "node src/index.js"
        }
        dependencies = @{
            express = "^4.19.2"
            cors = "^2.8.5"
        }
    } | ConvertTo-Json -Depth 10

    $packageJson | Out-File -FilePath "$svcPath\package.json" -Encoding utf8 -Force

    # Create src/index.js
    $indexJs = @"
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        service: '$($svc.name)',
        status: 'UP',
        port: $($svc.port),
        timestamp: new Date().toISOString()
    });
});

const PORT = $($svc.port);
app.listen(PORT, () => {
    console.log('$($svc.name) microservice listening on http://localhost:' + PORT);
});
"@

    $indexJs | Out-File -FilePath "$srcPath\index.js" -Encoding utf8 -Force
}

Write-Host "All service boilerplates created."

# Cloud Provider CLI Setup

**IMPORTANT:** Install the CLI for your target cloud provider before deploying.

## AWS CLI

```powershell
# Windows (PowerShell as Admin)
msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi /quiet

# Or via winget
winget install Amazon.AWSCLI

# Configure
aws configure
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output format (json)

# Verify
aws sts get-caller-identity
```

## Azure CLI

```powershell
# Windows (PowerShell as Admin)
winget install Microsoft.AzureCLI

# Or download MSI from: https://aka.ms/installazurecliwindows

# Login
az login

# Set subscription (if multiple)
az account set --subscription "Your Subscription Name"

# Verify
az account show
```

## GCP CLI (gcloud)

```powershell
# Windows - Download installer from:
# https://cloud.google.com/sdk/docs/install

# Or via PowerShell
(New-Object Net.WebClient).DownloadFile("https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe", "$env:TEMP\GoogleCloudSDKInstaller.exe")
& "$env:TEMP\GoogleCloudSDKInstaller.exe"

# Initialize and login
gcloud init
gcloud auth application-default login

# Enable Compute API
gcloud services enable compute.googleapis.com

# Verify
gcloud compute regions list
```

## OCI CLI (Oracle Cloud)

```powershell
# Windows (PowerShell as Admin)
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-WebRequest https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.ps1 -OutFile install.ps1
./install.ps1 -AcceptAllDefaults

# Restart terminal, then configure
oci setup config
# Enter: User OCID, Tenancy OCID, Region, generate new API key

# Upload public key to OCI Console → User Settings → API Keys

# Verify
oci iam region list --output table
```

## Terraform (Required for all providers)

```powershell
# Windows (winget)
winget install Hashicorp.Terraform

# Or download from: https://www.terraform.io/downloads

# Verify
terraform version
```

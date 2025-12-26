# Create Template Workflow

Create Ubuntu 24.04 LTS cloud-init template on XCP-ng if it doesn't exist.

## Trigger

- "create ubuntu template"
- "setup template"
- Before deploy if template missing

## Prerequisites

1. **XCP-ng host** accessible via SSH
2. **Storage repository** with sufficient space (10GB+)
3. **Network access** to download Ubuntu cloud image

## Template Specifications

| Property | Value |
|----------|-------|
| Name | `ubuntu-2404-cloud` |
| OS | Ubuntu 24.04 LTS (Noble Numbat) |
| Type | Cloud-init enabled |
| Image | Ubuntu cloud image (QCOW2) |
| Disk | 10GB (expandable) |
| RAM | 2GB (template default) |
| vCPU | 2 (template default) |

## Execution Steps

### Step 1: Check if Template Exists

```bash
# Via XO API
curl -sk "https://$XO_HOST/api" \
  -H "Authorization: Basic $(echo -n $XO_USER:$XO_PASSWORD | base64)" \
  -d '{"method":"vm.getAll","params":{}}' | jq '.[] | select(.name_label == "ubuntu-2404-cloud")'

# Via xe CLI (SSH)
ssh root@$XCPNG_HOST "xe template-list name-label=ubuntu-2404-cloud"
```

### Step 2: Download Ubuntu Cloud Image

```bash
# On XCP-ng host
cd /var/opt
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
```

### Step 3: Import as VM

```bash
# Import QCOW2 image
xe vm-import filename=/var/opt/noble-server-cloudimg-amd64.img format=raw

# Or create VM and attach disk
xe vm-install template="Other install media" new-name-label="ubuntu-2404-cloud-temp"
```

### Step 4: Configure VM for Cloud-Init

```bash
# Set other-config for cloud-init
xe vm-param-set uuid=$VM_UUID other-config:install-repository=cdrom
xe vm-param-set uuid=$VM_UUID other-config:cloud-config-drive=true
```

### Step 5: Convert to Template

```bash
xe vm-param-set uuid=$VM_UUID is-a-template=true
xe template-param-set uuid=$VM_UUID name-label="ubuntu-2404-cloud"
xe template-param-set uuid=$VM_UUID name-description="Ubuntu 24.04 LTS with cloud-init - PAI Hashcrack"
```

## CLI Usage

```bash
# Check and create template
bun run tools/CreateTemplate.ts

# Force recreate
bun run tools/CreateTemplate.ts --force
```

## Alternative: Xen Orchestra UI

1. Go to **Import > VM**
2. Select **From URL**
3. Enter: `https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img`
4. Name: `ubuntu-2404-cloud`
5. Enable **Cloud-init**
6. After import, right-click → **Convert to template**

## Verification

```bash
# List templates
xe template-list | grep ubuntu-2404

# Or via XO
xo-cli vm.getAll | jq '.[] | select(.is_a_template == true) | .name_label'
```

# =============================================================================
# Hashcrack Azure Infrastructure - Network Resources
# =============================================================================

# Resource Group
resource "azurerm_resource_group" "hashcrack" {
  name     = "${var.project_name}-${var.environment}-rg"
  location = var.azure_location

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Virtual Network
resource "azurerm_virtual_network" "hashcrack" {
  name                = "${var.project_name}-vnet"
  address_space       = [var.vnet_cidr]
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# Subnet
resource "azurerm_subnet" "hashcrack" {
  name                 = "${var.project_name}-subnet"
  resource_group_name  = azurerm_resource_group.hashcrack.name
  virtual_network_name = azurerm_virtual_network.hashcrack.name
  address_prefixes     = [var.subnet_cidr]
}

# =============================================================================
# Worker Internet Access
# =============================================================================
# Workers have public IPs (like AWS) to download packages during cloud-init.
# This is simpler and more reliable than NAT Gateway or file proxy approaches.
#
# Public IPs are allocated in workers.tf and attached to worker NICs.
# This enables workers to:
# - Run apt update/upgrade during cloud-init
# - Download Hashtopolis agent from GitHub
# - Download hashcat binary from hashcat.net
# =============================================================================

# =============================================================================
# Network Security Groups
# =============================================================================

# Server NSG
resource "azurerm_network_security_group" "server" {
  name                = "${var.project_name}-server-nsg"
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name

  security_rule {
    name                       = "SSH"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.allowed_ssh_cidr
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Hashtopolis-Web"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8080"
    source_address_prefixes    = var.allowed_ssh_cidr
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Agent-API"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8080"
    source_address_prefix      = var.subnet_cidr
    destination_address_prefix = "*"
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# Worker NSG
resource "azurerm_network_security_group" "worker" {
  name                = "${var.project_name}-worker-nsg"
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name

  security_rule {
    name                       = "SSH"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.allowed_ssh_cidr
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Internal"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = var.subnet_cidr
    destination_address_prefix = "*"
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# =============================================================================
# Random Resources
# =============================================================================

resource "random_password" "db_password" {
  length  = 24
  special = false
}

resource "random_string" "voucher" {
  count   = var.worker_voucher == "" ? (var.cpu_worker_count + var.gpu_worker_count) : 0
  length  = 12
  special = false
  upper   = true
}

# Local computed values
locals {
  total_worker_count = var.cpu_worker_count + var.gpu_worker_count
  voucher_codes      = var.worker_voucher != "" ? [var.worker_voucher] : random_string.voucher[*].result
  voucher_code       = length(local.voucher_codes) > 0 ? local.voucher_codes[0] : ""
  all_vouchers       = join(",", local.voucher_codes)
  db_password        = random_password.db_password.result
}

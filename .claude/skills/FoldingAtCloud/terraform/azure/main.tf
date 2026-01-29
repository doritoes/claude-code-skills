# =============================================================================
# Folding@Cloud Azure Infrastructure
# =============================================================================

# Resource Group
resource "azurerm_resource_group" "foldingcloud" {
  name     = "${var.project_name}-rg"
  location = var.location

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Virtual Network
resource "azurerm_virtual_network" "foldingcloud" {
  name                = "${var.project_name}-vnet"
  address_space       = ["10.100.0.0/16"]
  location            = azurerm_resource_group.foldingcloud.location
  resource_group_name = azurerm_resource_group.foldingcloud.name

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# Subnet
resource "azurerm_subnet" "workers" {
  name                 = "${var.project_name}-workers-subnet"
  resource_group_name  = azurerm_resource_group.foldingcloud.name
  virtual_network_name = azurerm_virtual_network.foldingcloud.name
  address_prefixes     = ["10.100.1.0/24"]
}

# Network Security Group - Minimal (outbound only for FAH)
resource "azurerm_network_security_group" "workers" {
  name                = "${var.project_name}-workers-nsg"
  location            = azurerm_resource_group.foldingcloud.location
  resource_group_name = azurerm_resource_group.foldingcloud.name

  # Allow SSH for management
  security_rule {
    name                       = "SSH"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # Allow all outbound (FAH uses outbound connections)
  security_rule {
    name                       = "AllowAllOutbound"
    priority                   = 100
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# =============================================================================
# FAH Worker VMs
# =============================================================================

# Public IPs for workers (needed for cloud-init and SSH access)
resource "azurerm_public_ip" "workers" {
  count               = var.worker_count
  name                = "${var.project_name}-worker-${count.index + 1}-pip"
  location            = azurerm_resource_group.foldingcloud.location
  resource_group_name = azurerm_resource_group.foldingcloud.name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "fah-worker"
    WorkerIndex = count.index + 1
  }
}

# Network Interfaces for workers
resource "azurerm_network_interface" "workers" {
  count               = var.worker_count
  name                = "${var.project_name}-worker-${count.index + 1}-nic"
  location            = azurerm_resource_group.foldingcloud.location
  resource_group_name = azurerm_resource_group.foldingcloud.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.workers.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.workers[count.index].id
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "fah-worker"
  }
}

# Associate NSG with worker NICs
resource "azurerm_network_interface_security_group_association" "workers" {
  count                     = var.worker_count
  network_interface_id      = azurerm_network_interface.workers[count.index].id
  network_security_group_id = azurerm_network_security_group.workers.id
}

# FAH Worker VMs
resource "azurerm_linux_virtual_machine" "workers" {
  count               = var.worker_count
  name                = "${var.project_name}-worker-${count.index + 1}"
  resource_group_name = azurerm_resource_group.foldingcloud.name
  location            = azurerm_resource_group.foldingcloud.location
  size                = var.worker_vm_size
  admin_username      = var.ssh_user

  # Spot instance configuration
  priority        = var.use_spot_instances ? "Spot" : "Regular"
  eviction_policy = var.use_spot_instances ? "Deallocate" : null
  max_bid_price   = var.use_spot_instances ? var.spot_max_price : null

  network_interface_ids = [
    azurerm_network_interface.workers[count.index].id
  ]

  admin_ssh_key {
    username   = var.ssh_user
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
    disk_size_gb         = var.worker_disk_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # Cloud-init for FAH setup
  custom_data = base64encode(templatefile("${path.module}/cloud-init/fah-worker.yaml", {
    hostname          = "${var.fah_machine_prefix}-${count.index + 1}"
    machine_name      = "${var.fah_machine_prefix}-${count.index + 1}"
    fah_account_token = var.fah_account_token
    fah_team_id       = var.fah_team_id
    cpu_count         = 0  # 0 = use all available CPUs
  }))

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "fah-worker"
    WorkerIndex = count.index + 1
    FAHMachine  = "${var.fah_machine_prefix}-${count.index + 1}"
  }

  lifecycle {
    ignore_changes = [custom_data]
  }
}

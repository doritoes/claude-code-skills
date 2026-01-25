# =============================================================================
# Hashcat CPU Worker VMs
# =============================================================================

# Workers need public IPs for cloud-init to download packages and hashcat binary
# Public IP Addresses for CPU Workers
resource "azurerm_public_ip" "cpu_workers" {
  count               = var.cpu_worker_count
  name                = "${var.project_name}-cpu-worker-${count.index + 1}-pip"
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "cpu-worker"
  }
}

# Network Interfaces for CPU Workers
resource "azurerm_network_interface" "cpu_workers" {
  count               = var.cpu_worker_count
  name                = "${var.project_name}-cpu-worker-${count.index + 1}-nic"
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.hashcrack.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.cpu_workers[count.index].id
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "cpu-worker"
  }
}

# Associate NSG with CPU Worker NICs
resource "azurerm_network_interface_security_group_association" "cpu_workers" {
  count                     = var.cpu_worker_count
  network_interface_id      = azurerm_network_interface.cpu_workers[count.index].id
  network_security_group_id = azurerm_network_security_group.worker.id
}

# CPU Worker VMs
resource "azurerm_linux_virtual_machine" "cpu_workers" {
  count               = var.cpu_worker_count
  name                = "${var.project_name}-cpu-worker-${count.index + 1}"
  resource_group_name = azurerm_resource_group.hashcrack.name
  location            = azurerm_resource_group.hashcrack.location
  size                = var.cpu_worker_vm_size
  admin_username      = var.ssh_user

  # Spot instance configuration (optional)
  priority        = var.use_spot_instances ? "Spot" : "Regular"
  eviction_policy = var.use_spot_instances ? "Deallocate" : null
  max_bid_price   = var.use_spot_instances ? var.spot_max_price : null

  network_interface_ids = [
    azurerm_network_interface.cpu_workers[count.index].id
  ]

  admin_ssh_key {
    username   = var.ssh_user
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.worker_disk_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/../cloud-init/worker.yaml", {
    hostname       = "${var.project_name}-cpu-worker-${count.index + 1}"
    worker_id      = count.index + 1
    ssh_user       = var.ssh_user
    ssh_public_key = var.ssh_public_key
    server_url     = azurerm_network_interface.server.private_ip_address
    voucher_code   = local.voucher_codes[count.index]
  }))

  depends_on = [time_sleep.wait_for_server]

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "cpu-worker"
  }

  lifecycle {
    ignore_changes = [custom_data]
  }
}

# =============================================================================
# Hashcat GPU Worker VMs
# =============================================================================

# GPU Workers need public IPs for cloud-init to download packages and hashcat binary
# Public IP Addresses for GPU Workers
resource "azurerm_public_ip" "gpu_workers" {
  count               = var.gpu_worker_count
  name                = "${var.project_name}-gpu-worker-${count.index + 1}-pip"
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "gpu-worker"
  }
}

# Network Interfaces for GPU Workers
resource "azurerm_network_interface" "gpu_workers" {
  count               = var.gpu_worker_count
  name                = "${var.project_name}-gpu-worker-${count.index + 1}-nic"
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.hashcrack.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.gpu_workers[count.index].id
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "gpu-worker"
  }
}

# Associate NSG with GPU Worker NICs
resource "azurerm_network_interface_security_group_association" "gpu_workers" {
  count                     = var.gpu_worker_count
  network_interface_id      = azurerm_network_interface.gpu_workers[count.index].id
  network_security_group_id = azurerm_network_security_group.worker.id
}

# GPU Worker VMs
resource "azurerm_linux_virtual_machine" "gpu_workers" {
  count               = var.gpu_worker_count
  name                = "${var.project_name}-gpu-worker-${count.index + 1}"
  resource_group_name = azurerm_resource_group.hashcrack.name
  location            = azurerm_resource_group.hashcrack.location
  size                = var.gpu_worker_vm_size
  admin_username      = var.ssh_user

  # GPU workers use on-demand by default for reliability
  priority        = var.use_spot_instances ? "Spot" : "Regular"
  eviction_policy = var.use_spot_instances ? "Deallocate" : null
  max_bid_price   = var.use_spot_instances ? var.spot_max_price : null

  network_interface_ids = [
    azurerm_network_interface.gpu_workers[count.index].id
  ]

  admin_ssh_key {
    username   = var.ssh_user
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.worker_disk_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/../cloud-init/worker-gpu.yaml", {
    hostname       = "${var.project_name}-gpu-worker-${count.index + 1}"
    worker_id      = 100 + count.index + 1
    ssh_user       = var.ssh_user
    ssh_public_key = var.ssh_public_key
    server_url     = azurerm_network_interface.server.private_ip_address
    voucher_code   = local.voucher_codes[var.cpu_worker_count + count.index]
  }))

  depends_on = [time_sleep.wait_for_server]

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "gpu-worker"
  }

  lifecycle {
    ignore_changes = [custom_data]
  }
}

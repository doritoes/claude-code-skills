# =============================================================================
# Hashtopolis Server VM
# =============================================================================

# Public IP for Server
resource "azurerm_public_ip" "server" {
  name                = "${var.project_name}-server-pip"
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "server"
  }
}

# Network Interface for Server
resource "azurerm_network_interface" "server" {
  name                = "${var.project_name}-server-nic"
  location            = azurerm_resource_group.hashcrack.location
  resource_group_name = azurerm_resource_group.hashcrack.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.hashcrack.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.server.id
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "server"
  }
}

# Associate NSG with Server NIC
resource "azurerm_network_interface_security_group_association" "server" {
  network_interface_id      = azurerm_network_interface.server.id
  network_security_group_id = azurerm_network_security_group.server.id
}

# Server VM
resource "azurerm_linux_virtual_machine" "server" {
  name                = "${var.project_name}-server"
  resource_group_name = azurerm_resource_group.hashcrack.name
  location            = azurerm_resource_group.hashcrack.location
  size                = var.server_vm_size
  admin_username      = var.ssh_user

  network_interface_ids = [
    azurerm_network_interface.server.id
  ]

  admin_ssh_key {
    username   = var.ssh_user
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.server_disk_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/../cloud-init/server.yaml", {
    hostname       = "${var.project_name}-server"
    ssh_user       = var.ssh_user
    ssh_public_key = var.ssh_public_key
    db_password    = local.db_password
    admin_user     = var.hashtopolis_admin_user
    admin_password = var.hashtopolis_admin_password
    voucher_code   = local.voucher_code
    all_vouchers   = local.all_vouchers
    worker_count   = local.total_worker_count
  }))

  tags = {
    Project     = var.project_name
    Environment = var.environment
    Role        = "server"
  }
}

# Wait for server to be ready
resource "time_sleep" "wait_for_server" {
  depends_on      = [azurerm_linux_virtual_machine.server]
  create_duration = "180s"  # 3 minutes for Docker + Hashtopolis to start
}

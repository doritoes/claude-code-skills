# =============================================================================
# OCI Security List (equivalent to Security Groups)
# =============================================================================

resource "oci_core_security_list" "hashcrack" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.hashcrack.id
  display_name   = "${var.project_name}-security-list"

  # ==========================================================================
  # Egress Rules - Allow all outbound
  # ==========================================================================
  egress_security_rules {
    destination      = "0.0.0.0/0"
    protocol         = "all"
    stateless        = false
    description      = "Allow all outbound traffic"
  }

  # ==========================================================================
  # Ingress Rules
  # ==========================================================================

  # SSH access
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    stateless   = false
    description = "SSH access"

    tcp_options {
      min = 22
      max = 22
    }
  }

  # Hashtopolis web interface
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    stateless   = false
    description = "Hashtopolis web UI"

    tcp_options {
      min = 8080
      max = 8080
    }
  }

  # Internal VCN communication (for workers to reach server)
  ingress_security_rules {
    protocol    = "all"
    source      = var.vcn_cidr
    stateless   = false
    description = "Internal VCN communication"
  }

  # ICMP for path discovery
  ingress_security_rules {
    protocol    = "1" # ICMP
    source      = "0.0.0.0/0"
    stateless   = false
    description = "ICMP for network diagnostics"

    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    protocol    = "1" # ICMP
    source      = var.vcn_cidr
    stateless   = false
    description = "ICMP from VCN"

    icmp_options {
      type = 3
    }
  }

  freeform_tags = local.common_tags
}

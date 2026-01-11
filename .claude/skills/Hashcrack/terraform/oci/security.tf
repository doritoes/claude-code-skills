# =============================================================================
# OCI Security Lists
# =============================================================================

resource "oci_core_security_list" "hashcrack" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.hashcrack.id
  display_name   = "${var.project_name}-security-list"

  # Allow all egress
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
    stateless   = false
  }

  # SSH access
  ingress_security_rules {
    protocol    = "6"  # TCP
    source      = var.allowed_ssh_cidr
    stateless   = false

    tcp_options {
      min = 22
      max = 22
    }
  }

  # Hashtopolis UI (port 8080)
  ingress_security_rules {
    protocol    = "6"  # TCP
    source      = var.allowed_ssh_cidr
    stateless   = false

    tcp_options {
      min = 8080
      max = 8080
    }
  }

  # Hashtopolis Angular Frontend (port 4200)
  ingress_security_rules {
    protocol    = "6"  # TCP
    source      = var.allowed_ssh_cidr
    stateless   = false

    tcp_options {
      min = 4200
      max = 4200
    }
  }

  # Internal VCN traffic - allow all
  ingress_security_rules {
    protocol    = "all"
    source      = var.vcn_cidr
    stateless   = false
  }

  # ICMP (ping)
  ingress_security_rules {
    protocol    = "1"  # ICMP
    source      = "0.0.0.0/0"
    stateless   = false

    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    protocol    = "1"  # ICMP
    source      = var.vcn_cidr
    stateless   = false

    icmp_options {
      type = 3
    }
  }

  freeform_tags = local.common_tags
}

"""Check registry.

Adding a check: create a module in this package, subclass Check,
decorate with @register, then import the module here so it self-registers
on load.
"""

from __future__ import annotations

from .base import Check, Finding, registry  # noqa: F401, public re-export

# Phase 1: schematic checks
from . import sch_01_erc  # noqa: F401
from . import sch_02_decoupling  # noqa: F401
from . import sch_03_power_symbols  # noqa: F401
from . import sch_04_net_naming  # noqa: F401
from . import sch_05_bom_complete  # noqa: F401
from . import sch_06_jlc_stock  # noqa: F401
from . import sch_07_bulk_cap  # noqa: F401
from . import sch_08_regulator_vout  # noqa: F401
from . import sch_09_driver_com_pin  # noqa: F401
from . import sch_10_usbc_cc_resistors  # noqa: F401
from . import sch_11_esp32_strapping  # noqa: F401

# Phase 2: PCB layout + DFM (silk-geometry PCB-12/15/16 + pour-stitching PCB-17 deferred)
from . import pcb_01_drc  # noqa: F401
from . import pcb_08_annular_ring  # noqa: F401
from . import pcb_10_testpoints  # noqa: F401
from . import pcb_11_fiducials  # noqa: F401
from . import pcb_13_mil_coord_sanity  # noqa: F401
from . import pcb_14_soldermask_expansion  # noqa: F401
from . import pcb_18_via_aspect_ratio  # noqa: F401
from . import pcb_20_mask_dam_width  # noqa: F401
from . import pcb_21_edge_clearance  # noqa: F401
from . import pcb_22_antenna_keepout  # noqa: F401

# Phase 3: layout signal integrity
from . import pcb_02_decoupling_proximity  # noqa: F401
from . import pcb_03_three_w_spacing  # noqa: F401
from . import pcb_05_tvs_proximity  # noqa: F401
from . import pcb_19_diff_pair_via_balance  # noqa: F401

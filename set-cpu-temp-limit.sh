#!/bin/bash
# Use Intel's native HWP (intel_pstate) to cap CPU performance and target ~45°C
# - Does NOT use custom frequency overrides
# - Does NOT touch network, peripherals, or power profile
# - Uses Intel manufacturer controls: max_perf_pct + EPP

# Target ~40°C: cap at 38% of max perf (3400 MHz * 0.38 = 1292 MHz)
MAX_PERF_PCT=${1:-38}
EPP="balance_power"

echo "Applying Intel HWP thermal control (manufacturer interface)..."
echo "  max_perf_pct : ${MAX_PERF_PCT}%"
echo "  EPP          : ${EPP}"
echo ""

# Intel P-state: set performance ceiling
echo "$MAX_PERF_PCT" > /sys/devices/system/cpu/intel_pstate/max_perf_pct

# Restore scaling_max_freq to hardware max (undo any previous custom cap)
HW_MAX=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq; do
    echo "$HW_MAX" > "$cpu/scaling_max_freq"
    echo "$EPP"    > "$cpu/energy_performance_preference"
done

echo "Current state:"
echo "  max_perf_pct : $(cat /sys/devices/system/cpu/intel_pstate/max_perf_pct)%"
echo "  min_perf_pct : $(cat /sys/devices/system/cpu/intel_pstate/min_perf_pct)%"
echo "  turbo        : $([ "$(cat /sys/devices/system/cpu/intel_pstate/no_turbo)" = "0" ] && echo ON || echo OFF)"
echo "  EPP          : $(cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference)"
echo "  effective max: $(($(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq) * MAX_PERF_PCT / 100 / 1000)) MHz"
echo ""
echo "Temperatures:"
for zone in /sys/class/thermal/thermal_zone*/; do
    name=$(cat "${zone}type" 2>/dev/null || echo "unknown")
    temp=$(($(cat "${zone}temp" 2>/dev/null) / 1000))
    printf "  %-25s %d°C\n" "$name" "$temp"
done

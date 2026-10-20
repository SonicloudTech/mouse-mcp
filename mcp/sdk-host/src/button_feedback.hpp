#pragma once
#include <array>
#include <cstdint>

namespace umcp {
// Cumulative edges, not just the latest state: a 1 ms down/up cannot disappear
// between two action polls. Times use the action's steady-clock millisecond domain.
struct ButtonSnapshot {
    std::array<uint64_t,5> downs{},ups{};
    std::array<double,5> downMs{},upMs{};
    int held=0,globalHeld=0;
    uint64_t anomalies=0;
    bool healthy=true;
};
}

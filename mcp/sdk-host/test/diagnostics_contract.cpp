#include "diagnostics.hpp"
int main(){
    umcp::DiagnosticLog log("bounded-test");
    for(int i=0;i<10000;i++)log.record("load",{{"padding",std::string(4096,'x')}});
    return 0;
}

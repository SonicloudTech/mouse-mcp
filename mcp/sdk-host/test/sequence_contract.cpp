#include "input_sequence.hpp"
#include <iostream>
using namespace umcp;
int main(int argc,char** argv){try{
    if(argc!=2)throw std::runtime_error("case required");std::string name=argv[1];
    auto require=[](bool ok){if(!ok)throw std::runtime_error("sequence assertion failed");};
    double time=0;bool online=true,cancel=false;Json::Array writes;
    SequencePort p;p.now=[&]{return time;};p.sleep=[&](int ms){time+=ms;if(name=="cancel")cancel=true;if(name=="disconnect")online=false;};
    p.current=[&]{return online;};p.cancelled=[&]{return cancel;};
    p.write=[&](const Json& f){writes.push_back(f);if(name=="write-throws"&&writes.size()==1)throw std::runtime_error("fixture");if((name=="release-fails"&&writes.size()==2)||name=="write-fails")return 0;return 1;};
    Json key=Json::Object{{"kind","keyboard"},{"keys",Json::Array{4}},{"modifiers",0},{"delayMs",30}};
    Json mouse=Json::Object{{"kind","mouse"},{"buttons",1},{"delayMs",30}};
    Json::Array frames{key};if(name=="mixed")frames.push_back(mouse);
    if(name=="focus-after")frames.push_back(key);
    if(name=="invalid-tail")frames.push_back(Json::Object{{"kind","keyboard"},{"keys",Json::Array{1}}});
    if(name=="invalid-delay")frames.push_back(Json::Object{{"kind","mouse"},{"delayMs",0}});
    if(name=="unsupported-buttons")frames.push_back(Json::Object{{"kind","mouse"},{"buttons",8}});
    if(name=="duplicate")frames.push_back(Json::Object{{"kind","keyboard"},{"keys",Json::Array{4,4}}});
    if(name=="cancel-before")cancel=true;
    if(name=="deadline")p.sleep=[&](int){time=20001;};
    auto r=inputSequence(Json::Object{{"frames",frames},{"budgetMs",20000}},p);
    require(!r.boolean("effectConfirmed"));
    if(name=="keyboard"||name=="mixed"||name=="focus-before"){
        require(r.text("outcome")=="completed");require(writes.size()==(name=="mixed"?4:2));require(r.text("cleanup")=="release_written");
        require(writes.back().get("keys").items().empty());
    }else if(name=="focus-after"){require(r.text("outcome")=="completed");require(writes.size()==3);require(r.text("cleanup")=="release_written");
    }else if(name=="invalid-tail"||name=="invalid-delay"||name=="unsupported-buttons"||name=="duplicate"||name=="cancel-before"){
        require(writes.empty());require(r.text("outcome")== (name=="cancel-before"?"aborted":"rejected"));
    }else{
        require(r.text("outcome")=="indeterminate");
        require(writes.size()==(name=="disconnect"?1:2));
        require(r.text("cleanup")==((name=="disconnect"||name=="release-fails"||name=="write-fails")?"release_unconfirmed":"release_written"));
    }
    require(r.get("transport").get("attempted").integer()==static_cast<int64_t>(writes.size()));
    std::cout<<"PASS "<<name<<" fake ports only\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what();return 1;}}

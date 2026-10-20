using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
class MouseSurface : Form {
  string log; int down,up,click,dbl,wheel,moves; Point dragStart; bool dragging; string last="Ready";
  MouseSurface(string file) {
    log=file; Text="uMouse hardware test surface"; StartPosition=FormStartPosition.Manual;
    Location=new Point(160,120); ClientSize=new Size(900,600); BackColor=Color.FromArgb(235,244,251);
    DoubleBuffered=true; SetStyle(ControlStyles.StandardDoubleClick,true);
    MouseDown+=(s,e)=>{down++;dragStart=e.Location;dragging=true; Write("down",e);Invalidate();};
    MouseUp+=(s,e)=>{up++;Write("up",e);if(dragging) File.AppendAllText(log,DateTime.UtcNow.ToString("O")+" dragDelta "+(e.X-dragStart.X)+","+(e.Y-dragStart.Y)+Environment.NewLine);dragging=false;Invalidate();};
    MouseClick+=(s,e)=>{click++;Write("click",e);Invalidate();};
    MouseDoubleClick+=(s,e)=>{dbl++;Write("double",e);Invalidate();};
    MouseMove+=(s,e)=>{moves++;Write("move",e);Invalidate();};
    MouseWheel+=(s,e)=>{wheel+=e.Delta;Write("wheel",e);Invalidate();};
    Shown+=(s,e)=>File.AppendAllText(log,DateTime.UtcNow.ToString("O")+" ready clientOrigin="+PointToScreen(Point.Empty)+Environment.NewLine);
  }
  void Write(string type,MouseEventArgs e) {
    last=type+" "+e.Button+" "+e.X+","+e.Y+" delta="+e.Delta;
    File.AppendAllText(log,DateTime.UtcNow.ToString("O")+" "+last+" screen="+PointToScreen(e.Location)+Environment.NewLine);
  }
  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e); using(var f=new Font("Segoe UI",18)){
      e.Graphics.DrawString("uMouse hardware test surface\nSafe local window: no links or destructive actions\n\nDown: "+down+"   Up: "+up+"   Click: "+click+"   Double: "+dbl+"\nWheel delta: "+wheel+"   Move events: "+moves+"\n\n"+last,f,Brushes.Black,30,30);
      e.Graphics.DrawRectangle(Pens.SteelBlue,100,300,650,180);
      e.Graphics.DrawString("Mouse test area",f,Brushes.SteelBlue,310,365);
    }
  }
  [STAThread] static void Main(string[] args) { Application.EnableVisualStyles();Application.Run(new MouseSurface(args.Length>0?args[0]:Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"surface.log"))); }
}

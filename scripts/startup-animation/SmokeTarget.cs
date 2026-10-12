using System;
using System.Drawing;
using System.Windows.Forms;
public static class SmokeTarget {
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
 [System.Runtime.InteropServices.DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [STAThread] public static void Main(string[] args) {
  Application.EnableVisualStyles();
  if(args.Length>0&&args[0].StartsWith("--delay="))System.Threading.Thread.Sleep(Int32.Parse(args[0].Substring(8)));
  Form form=new Form { Text="Cyrene Boot — isolated window test",ClientSize=new Size(1000,650),BackColor=Color.FromArgb(253,250,255),StartPosition=FormStartPosition.CenterScreen };
  Panel sidebar=new Panel { Dock=DockStyle.Left,Width=240,BackColor=Color.FromArgb(239,232,246) };
  sidebar.Controls.Add(new Label { Text="CYRENE\n\nWindow handoff test",Dock=DockStyle.Fill,Padding=new Padding(28),Font=new Font("Segoe UI",17),ForeColor=Color.FromArgb(103,77,134) });
  form.Controls.Add(new Label { Text="Isolated test window\n\nNo user conversations or credentials are loaded.",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter,Font=new Font("Segoe UI",18),ForeColor=Color.FromArgb(121,93,145) });
  form.Controls.Add(sidebar);
  if(Array.IndexOf(args,"--focus-test")>=0) {
   form.Shown+=delegate {
    form.Activate();
    SetForegroundWindow(form.Handle);
    bool foreground=GetForegroundWindow()==form.Handle;
    System.IO.File.WriteAllText(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"focus.txt"),
     foreground?"target-took-focus":"foreground-unavailable");
   };
  }
  if(Array.IndexOf(args,"--visibility-test")>=0) {
   string report=System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"visibility.txt");
   System.IO.File.WriteAllText(report,"");
   var elapsed=System.Diagnostics.Stopwatch.StartNew();
   bool during=false,after=false;
   Timer visibility=new Timer { Interval=100 };
   visibility.Tick+=delegate {
    if(!during&&elapsed.Elapsed.TotalSeconds>=8) {
     during=true;System.IO.File.AppendAllText(report,IsWindowVisible(form.Handle)?"early-visible\n":"hidden-during-video\n");
    }
    if(!after&&elapsed.Elapsed.TotalSeconds>=17) {
     after=true;System.IO.File.AppendAllText(report,IsWindowVisible(form.Handle)?"visible-after-video\n":"stuck-hidden\n");visibility.Stop();
    }
   };
   visibility.Start();
  }
  Timer timer=new Timer { Interval=40000 };timer.Tick+=delegate { form.Close(); };timer.Start();
  Application.Run(form);
 }
}

import Cocoa
let folder = CommandLine.arguments[1]
for pixels in [16,32,64,128,256,512,1024] {
 let size = CGFloat(pixels)
 let image = NSImage(size:NSSize(width:size,height:size))
 image.lockFocus()
 NSColor(calibratedRed:0.07,green:0.10,blue:0.17,alpha:1).setFill()
 NSBezierPath(roundedRect:NSRect(x:0,y:0,width:size,height:size),xRadius:size*0.22,yRadius:size*0.22).fill()
 let screen=NSRect(x:size*0.17,y:size*0.24,width:size*0.66,height:size*0.53)
 NSColor(calibratedRed:0.39,green:0.65,blue:1,alpha:1).setStroke()
 let path=NSBezierPath(roundedRect:screen,xRadius:size*0.05,yRadius:size*0.05);path.lineWidth=size*0.035;path.stroke()
 NSColor.white.setFill()
 NSBezierPath(roundedRect:NSRect(x:size*0.26,y:size*0.54,width:size*0.37,height:size*0.045),xRadius:2,yRadius:2).fill()
 NSColor(calibratedRed:0.48,green:0.60,blue:0.79,alpha:1).setFill()
 for y in [0.43,0.35] { NSBezierPath(roundedRect:NSRect(x:size*0.26,y:size*y,width:size*0.27,height:size*0.025),xRadius:1,yRadius:1).fill() }
 NSColor(calibratedRed:0.44,green:0.83,blue:0.72,alpha:1).setFill()
 let play=NSBezierPath();play.move(to:NSPoint(x:size*0.64,y:size*0.35));play.line(to:NSPoint(x:size*0.64,y:size*0.49));play.line(to:NSPoint(x:size*0.74,y:size*0.42));play.close();play.fill()
 image.unlockFocus()
 let data=NSBitmapImageRep(data:image.tiffRepresentation!)!.representation(using:.png,properties:[:])!
 if [16,32,128,256,512].contains(pixels) { try! data.write(to:URL(fileURLWithPath:folder+"/icon_\(pixels)x\(pixels).png")) }
 if [32,64,256,512,1024].contains(pixels) { try! data.write(to:URL(fileURLWithPath:folder+"/icon_\(pixels/2)x\(pixels/2)@2x.png")) }
}

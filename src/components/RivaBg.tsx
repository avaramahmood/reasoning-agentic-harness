import type { ReactNode } from "react";

const PolygonBackground = ({ children }: { children?: ReactNode }) => {
 return (
 <div style={{ position: 'relative' }}>
 <div 
 aria-hidden="true"
 style={{
 position: 'fixed',
 top: 0,
 left: 0,
 width: '100vw',
 height: '100vh',
 pointerEvents: 'none', 
 zIndex: -1, 
 overflow: 'hidden',
 backgroundColor: '#050508' 
 }}
 >
 {/* Shared Gradients */}
 <svg style={{ width: 0, height: 0, position: 'absolute' }}>
 <defs>
 <linearGradient id="polyCyan" x1="0%" y1="0%" x2="0%" y2="100%">
 <stop offset="0%" stopColor="rgba(45, 212, 191, 0.18)" />
 <stop offset="100%" stopColor="rgba(45, 212, 191, 0.03)" />
 </linearGradient>

 <linearGradient id="polyPurple" x1="0%" y1="0%" x2="0%" y2="100%">
 <stop offset="0%" stopColor="rgba(227, 218, 160, 0.15)" />
 <stop offset="100%" stopColor="rgba(186, 175, 115, 0.03)" />
 </linearGradient>

 <linearGradient id="polyIndigo" x1="0%" y1="0%" x2="0%" y2="100%">
 <stop offset="0%" stopColor="rgba(45, 212, 191, 0.15)" />
 <stop offset="100%" stopColor="rgba(13, 148, 136, 0.02)" />
 </linearGradient>
 
 <linearGradient id="polyGold" x1="0%" y1="0%" x2="0%" y2="100%">
 <stop offset="0%" stopColor="rgba(186, 175, 115, 0.12)" />
 <stop offset="100%" stopColor="rgba(115, 108, 58, 0.02)" />
 </linearGradient>
 </defs>
 </svg>

 {/* Top Right Polygons */}
 <svg 
 viewBox="0 0 500 500" 
 style={{
 position: 'absolute',
 top: 0,
 right: 0,
 width: '65vw',
 minWidth: '450px',
 maxWidth: '1000px',
 opacity: 0.35,
 }}
 >
 <g stroke="rgba(186, 175, 115, 0.22)" strokeWidth="1.5" strokeLinejoin="round">
 <polygon points="300,0 500,0 400,150" fill="url(#polyCyan)" />
 <polygon points="500,0 500,250 400,150" fill="url(#polyPurple)" />
 <polygon points="400,150 500,250 350,350" fill="url(#polyIndigo)" />
 <polygon points="200,0 300,0 400,150" fill="url(#polyGold)" />
 <polygon points="100,0 200,0 250,150" fill="url(#polyIndigo)" />
 <polygon points="200,0 250,150 400,150" fill="url(#polyCyan)" />
 <polygon points="250,150 400,150 280,280" fill="url(#polyPurple)" />
 <polygon points="400,150 350,350 280,280" fill="url(#polyGold)" />
 </g>
 </svg>

 {/* Bottom Left Polygons (Redesigned Taper) */}
 <svg 
 viewBox="0 0 500 500" 
 style={{
 position: 'absolute',
 bottom: 0,
 left: 0,
 width: '70vw',
 minWidth: '500px',
 maxWidth: '1100px',
 opacity: 0.35,
 }}
 >
 <g stroke="rgba(186, 175, 115, 0.22)" strokeWidth="1.5" strokeLinejoin="round">
 <polygon points="0,500 200,500 100,400" fill="url(#polyCyan)" />
 <polygon points="0,500 100,400 0,300" fill="url(#polyPurple)" />
 <polygon points="100,400 200,500 250,380" fill="url(#polyIndigo)" />
 <polygon points="200,500 350,500 250,380" fill="url(#polyGold)" />
 <polygon points="250,380 350,500 380,420" fill="url(#polyCyan)" />
 <polygon points="350,500 450,500 380,420" fill="url(#polyPurple)" />
 <polygon points="0,300 100,400 120,250" fill="url(#polyGold)" />
 <polygon points="100,400 250,380 280,300" fill="url(#polyCyan)" />
 <polygon points="100,400 280,300 120,250" fill="url(#polyPurple)" />
 <polygon points="250,380 380,420 280,300" fill="url(#polyIndigo)" />
 <polygon points="0,300 120,250 0,150" fill="url(#polyCyan)" />
 <polygon points="120,250 280,300 180,180" fill="url(#polyGold)" />
 <polygon points="0,150 120,250 180,180" fill="url(#polyIndigo)" />
 </g>
 </svg>
 </div>

 {/* Foreground Content */}
 <div style={{ position: 'relative', zIndex: 0 }}>
 {children}
 </div>
 </div>
 );
};

export default PolygonBackground;

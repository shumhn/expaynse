import React from 'react'

interface LoaderProps {
  text?: string;
  size?: 'sm' | 'md' | 'lg';
  fullScreen?: boolean;
}

export function ExpaynseLoader({ text = 'Loading', size = 'md', fullScreen = true }: LoaderProps) {
  const [dots, setDots] = React.useState('')

  React.useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.')
    }, 400)
    return () => clearInterval(interval)
  }, [])

  const sizeClasses = {
    sm: { ring: 'w-10 h-10', outer: 'p-1.5', emoji: 'text-lg', dot: 'w-1 h-1' },
    md: { ring: 'w-14 h-14', outer: 'p-2', emoji: 'text-2xl', dot: 'w-1.5 h-1.5' },
    lg: { ring: 'w-20 h-20', outer: 'p-3', emoji: 'text-3xl', dot: 'w-2 h-2' },
  }

  const s = sizeClasses[size]

  const loader = (
    <div className="flex flex-col justify-center items-center gap-4">
      <div className="relative flex items-center justify-center">
        <div className="absolute inset-0 bg-emerald-400/20 blur-xl rounded-full scale-150 animate-pulse" />
        <div className="absolute inset-0 flex items-center justify-center opacity-20">
          <div className="absolute w-px h-16 bg-emerald-400" />
          <div className="absolute w-16 h-px bg-emerald-400" />
        </div>
        <div className={`relative ${s.outer} border border-dashed border-emerald-400/30 rounded-full animate-[spin_3s_linear_infinite]`}>
          <div className={`${s.ring} border border-dashed border-emerald-300/50 rounded-full flex justify-center items-center animate-[spin_2s_linear_infinite_reverse]`}>
            <div className="relative z-10 p-2 bg-white rounded-full border border-emerald-400/40 shadow-[0_0_20px_-5px_#00E559]">
              <span className={`${s.emoji} animate-[pulse_2s_ease-in-out_infinite]`}>E</span>
            </div>
          </div>
          <div className={`absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 ${s.dot} bg-emerald-400 rounded-full shadow-[0_0_8px_#00E559]`} />
          <div className={`absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 ${s.dot} bg-emerald-300 rounded-full shadow-[0_0_8px_#00E559]`} />
          <div className={`absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 ${s.dot} bg-emerald-300 rounded-full shadow-[0_0_8px_#00E559]`} />
          <div className={`absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 ${s.dot} bg-emerald-400 rounded-full shadow-[0_0_8px_#00E559]`} />
        </div>
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="text-xs font-mono tracking-[0.2em] text-emerald-400 uppercase">
          {text}{dots}
        </p>
        <p className="text-[10px] text-gray-400/50">Privacy-First Payroll</p>
      </div>
    </div>
  )

  if (fullScreen) {
    return (
      <div className='w-full h-screen bg-white flex flex-col justify-center items-center'>
        {loader}
      </div>
    )
  }

  return loader
}
